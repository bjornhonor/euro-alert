/**
 * Reconstrói as épocas históricas a partir dos fechamentos no D1 (mesma regra dos alertas) e
 * deixa o placar pronto: cada época vira um alerta "início" de mentira (`backfill`) com as
 * médias de 1, 3 e 6 meses seguintes. Se a última época ainda estiver aberta, o estado dos
 * alertas começa nela (assim o app não avisa "começou" de uma época que começou antes).
 *
 *   npm run epochs -- --local | --remote [--force]
 *
 * Rode uma vez, antes de ligar os alertas. Recusa se já houver épocas ao vivo (use --force).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { historicalEpochs } from "../src/alerts/history";
import { outcomeFrom, WINDOWS } from "../src/alerts/outcomes";

const target = process.argv.includes("--remote")
  ? "--remote"
  : process.argv.includes("--local")
    ? "--local"
    : "";
if (!target) {
  console.error("Uso: npm run epochs -- --local | --remote [--force]");
  process.exit(1);
}

/** Chama o wrangler pelo Node, sem shell (no Windows o shell quebraria o SQL nos espaços). */
const WRANGLER = ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "euro-alert", target];

function d1<T>(sql: string): T[] {
  const out = execFileSync(process.execPath, [...WRANGLER, "--json", `--command=${sql}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(out.slice(out.indexOf("["))) as { results: T[] }[])[0]!.results;
}

const live = d1<{ n: number }>("SELECT COUNT(*) AS n FROM epochs WHERE source = 'live'")[0]!.n;
if (live > 0 && !process.argv.includes("--force")) {
  console.error(`Já existem ${live} épocas ao vivo. Use --force para recalcular mesmo assim.`);
  process.exit(1);
}

const rows = d1<{ date: string; close: number }>(
  "SELECT date, close FROM daily_close WHERE pair = 'EURBRL' ORDER BY date",
);
const dates = rows.map((r) => r.date);
const prices = rows.map((r) => r.close);
const epochs = historicalEpochs(dates, prices);

/** 18h de Brasília do dia (21h UTC): a data em Brasília continua a mesma. */
const tsOf = (date: string) => Date.parse(`${date}T21:00:00Z`);
const q = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`);

const sql: string[] = [
  "DELETE FROM alert_outcomes WHERE alert_id IN (SELECT id FROM alerts WHERE json_extract(context, '$.backfill') = 1);",
  "DELETE FROM alerts WHERE json_extract(context, '$.backfill') = 1;",
  "DELETE FROM epochs WHERE source = 'backfill';",
];
for (const e of epochs) {
  const i = dates.indexOf(e.start);
  const o = outcomeFrom(prices.slice(i + 1, i + 1 + WINDOWS.m6));
  sql.push(
    "INSERT INTO epochs (start_ts, end_ts, entry_price, min_price, min_dist, min_ts, max_level, source) VALUES " +
      `(${tsOf(e.start)}, ${e.end ? tsOf(e.end) : "NULL"}, ${e.entryPrice}, ${e.minPrice}, ${e.minDist}, ` +
      `${tsOf(e.minDate)}, '${e.maxLevel}', 'backfill');`,
    "INSERT INTO alerts (ts, kind, level, price, dist250, epoch_id, context, delivered) VALUES " +
      `(${tsOf(e.start)}, 'epoca_inicio', '${e.entryLevel}', ${e.entryPrice}, ${e.entryDist}, ` +
      `(SELECT MAX(id) FROM epochs), '{"backfill":true}', 0);`,
    "INSERT INTO alert_outcomes (alert_id, avg_1m, avg_3m, avg_6m, min_3m, updated) VALUES " +
      `((SELECT MAX(id) FROM alerts), ${q(o.avg1m)}, ${q(o.avg3m)}, ${q(o.avg6m)}, ${q(o.min3m)}, ${Date.now()});`,
  );
}

const last = epochs.at(-1);
if (last && last.end === null) {
  sql.push(
    "INSERT OR REPLACE INTO state (key, value, updated) VALUES ('epoch_state', json_object(" +
      "'active', json('true'), 'epochId', (SELECT id FROM epochs WHERE source = 'backfill' ORDER BY start_ts DESC LIMIT 1), " +
      `'startTs', ${tsOf(last.start)}, 'entryPrice', ${last.entryPrice}, 'minPrice', ${last.minPrice}, ` +
      `'minDist', ${last.minDist}, 'minTs', ${tsOf(last.minDate)}, 'levelAlerted', '${last.maxLevel}', ` +
      "'pendingEnter', 0, 'pendingExit', 0, 'pendingLevel', json('null'), 'lastSurgeTs', json('null'), " +
      `'lastSeasonal', json('null')), ${Date.now()});`,
  );
} else {
  sql.push("DELETE FROM state WHERE key = 'epoch_state';");
}

mkdirSync(".wrangler", { recursive: true });
const file = ".wrangler/epochs.sql";
writeFileSync(file, sql.join("\n") + "\n");

const years = (Date.parse(dates.at(-1)!) - Date.parse(dates[249]!)) / (365.25 * 86_400_000);
const reach = (lvl: string[]) => epochs.filter((e) => lvl.includes(e.maxLevel)).length;
console.log(
  `${epochs.length} épocas em ${years.toFixed(1)} anos (${(epochs.length / years).toFixed(1)}/ano); ` +
    `chegaram a −5%: ${reach(["muito_boa", "rara"])}; a −8%: ${reach(["rara"])}.`,
);
if (last?.end === null) {
  console.log(
    `Época aberta desde ${last.start} (nível ${last.maxLevel}, mínimo ${last.minPrice} em ${last.minDate}).`,
  );
}
execFileSync(process.execPath, [...WRANGLER, `--file=${file}`, "--yes"], { stdio: "inherit" });
