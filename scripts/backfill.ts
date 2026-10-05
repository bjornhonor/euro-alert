/**
 * Carrega o histórico no D1: fechamento diário do EUR/BRL desde 2002 (BCE até a véspera do
 * primeiro dia da Wise, Wise daí em diante), Selic meta, IPCA e inflação da zona do euro.
 *
 *   npm run backfill -- --local     # banco local (wrangler dev / testes manuais)
 *   npm run backfill -- --remote    # banco na Cloudflare
 *
 * Idempotente: fechamentos entram com INSERT OR IGNORE (não sobrescrevem os dados próprios
 * do app); séries macro com INSERT OR REPLACE.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const target = process.argv.includes("--remote")
  ? "--remote"
  : process.argv.includes("--local")
    ? "--local"
    : "";
if (!target) {
  console.error("Uso: npm run backfill -- --local | --remote");
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

async function getJson<T>(url: string, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${(err as Error).message}`, { cause: err });
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const isWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};
const br = (date: string) => date.split("-").reverse().join("/");
const today = iso(new Date(Date.now() - 3 * 3600_000)); // Brasília

// ---------------------------------------------------------------- câmbio
type Close = { date: string; close: number; source: "ecb" | "wise" };

const wise = await getJson<{ value: number; time: number }[]>(
  "https://wise.com/rates/history+live?source=EUR&target=BRL&length=5&resolution=daily&unit=year",
);
// Mesmo critério da pesquisa em Python: data UTC do ponto, só dias úteis, último ponto do dia.
const wiseByDate = new Map<string, number>();
for (const p of wise) wiseByDate.set(iso(new Date(p.time)), p.value);
wiseByDate.delete(today); // o dia de hoje ainda não fechou
const wiseCloses: Close[] = [...wiseByDate]
  .filter(([date]) => isWeekday(date))
  .map(([date, close]) => ({ date, close, source: "wise" as const }))
  .sort((a, b) => a.date.localeCompare(b.date));
const firstWise = wiseCloses[0]!.date;

const lastEcb = iso(new Date(Date.parse(`${firstWise}T00:00:00Z`) - 86_400_000));
const ecb = await getJson<{ rates: Record<string, { BRL: number }> }>(
  `https://api.frankfurter.dev/v1/2002-01-01..${lastEcb}?base=EUR&symbols=BRL`,
);
// A Frankfurter devolve também o último dia útil antes do início pedido (28/12/2001): fica de fora.
const ecbCloses: Close[] = Object.entries(ecb.rates)
  .filter(([date]) => date >= "2002-01-01")
  .map(([date, r]) => ({
    date,
    close: r.BRL,
    source: "ecb" as const,
  }));

// ---------------------------------------------------------------- macro
type Obs = { series: string; date: string; value: number };

async function sgs(series: number, from: string, to: string) {
  const rows = await getJson<{ data: string; valor: string }[]>(
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series}/dados?formato=json&dataInicial=${br(from)}&dataFinal=${br(to)}`,
  );
  return rows
    .map((r) => ({ date: r.data.split("/").reverse().join("-"), value: Number(r.valor) }))
    .filter((o) => o.date <= today);
}

// Selic diária, em janelas de 10 anos; guarda só os dias em que mudou (e o último).
const selicDaily: { date: string; value: number }[] = [];
for (let y = 2002; y <= Number(today.slice(0, 4)); y += 10) {
  const to = `${Math.min(y + 9, Number(today.slice(0, 4)))}-12-31`;
  selicDaily.push(...(await sgs(432, `${y}-01-01`, to < today ? to : today)));
}
const selic: Obs[] = selicDaily
  .filter((o, i) => i === 0 || i === selicDaily.length - 1 || o.value !== selicDaily[i - 1]!.value)
  .map((o) => ({ series: "selic", ...o }));

const ipca: Obs[] = (await sgs(433, "2001-12-01", today)).map((o) => ({ series: "ipca", ...o }));

const hicpJson = await getJson<{
  value: Record<string, number>;
  dimension: { time: { category: { index: Record<string, number> } } };
}>(
  "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr?geo=EA&coicop18=TOTAL&unit=I25&sinceTimePeriod=2001-12",
);
const hicp: Obs[] = Object.entries(hicpJson.dimension.time.category.index)
  .filter(([, pos]) => hicpJson.value[String(pos)] !== undefined)
  .map(([month, pos]) => ({ series: "hicp_ea", date: `${month}-01`, value: hicpJson.value[String(pos)]! }));

// ---------------------------------------------------------------- SQL
const lines: string[] = [];
function inserts<T>(verb: string, table: string, cols: string, rows: T[], fmt: (r: T) => string) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows
      .slice(i, i + 200)
      .map(fmt)
      .join(",\n");
    lines.push(`${verb} INTO ${table} (${cols}) VALUES\n${chunk};`);
  }
}
const closes = [...ecbCloses, ...wiseCloses];
inserts(
  "INSERT OR IGNORE",
  "daily_close",
  "pair, date, close, source",
  closes,
  (c) => `('EURBRL', '${c.date}', ${c.close}, '${c.source}')`,
);
inserts(
  "INSERT OR REPLACE",
  "macro_series",
  "series, date, value",
  [...selic, ...ipca, ...hicp],
  (o) => `('${o.series}', '${o.date}', ${o.value})`,
);

mkdirSync(".wrangler", { recursive: true });
const file = ".wrangler/backfill.sql";
writeFileSync(file, lines.join("\n") + "\n");

console.log(
  `BCE: ${ecbCloses.length} dias (2002-01-02 a ${lastEcb}) · Wise: ${wiseCloses.length} dias (${firstWise} a ${wiseCloses.at(-1)!.date})\n` +
    `Selic: ${selic.length} mudanças · IPCA: ${ipca.length} meses · inflação do euro: ${hicp.length} meses\n` +
    `SQL em ${file}; aplicando com wrangler (${target})…`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "euro-alert", target, `--file=${file}`, "--yes"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

export {};
