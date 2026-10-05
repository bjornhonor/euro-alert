import { YEAR } from "../engine/epoch";
import { type FetchFn, httpJson } from "../lib/http";

export type ChartRange = "90d" | "1a" | "5a";

export const RANGE_DAYS: Record<ChartRange, number> = { "90d": 90, "1a": 250, "5a": 1260 };
const RANGE_NAME: Record<ChartRange, string> = { "90d": "90 dias", "1a": "1 ano", "5a": "5 anos" };

export function parseRange(arg?: string): ChartRange | undefined {
  const a = (arg ?? "").trim().toLowerCase();
  if (a === "" || a === "1a" || a === "1ano" || a === "1y") return "1a";
  if (a === "90d" || a === "90") return "90d";
  if (a === "5a" || a === "5anos" || a === "5y") return "5a";
  return undefined;
}

export interface ChartInput {
  /** Fechamentos com folga de 1 ano antes do período (para a média de 12 meses). */
  dates: readonly string[];
  prices: readonly number[];
  range: ChartRange;
  /** Épocas (datas de início e fim; fim null = aberta) para sombrear. */
  epochs: readonly { start: string; end: string | null }[];
}

const label = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(2, 4)}`;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Configuração Chart.js (v2, a padrão do QuickChart): preço, média de 12 meses, as linhas de
 * −3%, −5% e −8% e as épocas sombreadas. Em 5 anos usa um ponto por semana.
 */
export function buildChartConfig(input: ChartInput): object {
  const { dates, prices, range } = input;
  const n = Math.min(RANGE_DAYS[range], prices.length - YEAR + 1);
  const step = range === "5a" ? 5 : 1;
  const idx: number[] = [];
  for (let i = prices.length - n; i < prices.length; i += step) idx.push(i);
  if (idx.at(-1) !== prices.length - 1) idx.push(prices.length - 1);

  // média de 250 dias úteis em cada ponto (soma corrida)
  const sma: number[] = new Array(prices.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i]!;
    if (i >= YEAR) sum -= prices[i - YEAR]!;
    if (i >= YEAR - 1) sma[i] = sum / YEAR;
  }

  const labels = idx.map((i) => label(dates[i]!));
  const line = (data: number[], color: string, extra: object = {}) => ({
    data: data.map(r4),
    borderColor: color,
    fill: false,
    pointRadius: 0,
    borderWidth: 1,
    ...extra,
  });
  const first = dates[idx[0]!]!;
  const last = dates[idx.at(-1)!]!;
  const boxes = input.epochs
    .filter((e) => (e.end ?? last) >= first && e.start <= last)
    .map((e) => {
      // encaixa nas datas que existem no eixo
      const from = idx.find((i) => dates[i]! >= e.start) ?? idx[0]!;
      const to = [...idx].reverse().find((i) => dates[i]! <= (e.end ?? last)) ?? idx.at(-1)!;
      return {
        type: "box",
        xScaleID: "x-axis-0",
        xMin: label(dates[from]!),
        xMax: label(dates[to]!),
        backgroundColor: "rgba(46, 160, 67, 0.12)",
        borderColor: "rgba(0, 0, 0, 0)", // sem borda (borderWidth 0 é ignorado pelo plugin)
        borderWidth: 0,
      };
    });

  return {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "EUR/BRL",
          ...line(
            idx.map((i) => prices[i]!),
            "#1f4e9c",
            { borderWidth: 2 },
          ),
        },
        {
          label: "Média 12 meses",
          ...line(
            idx.map((i) => sma[i]!),
            "#555555",
            { borderDash: [6, 4] },
          ),
        },
        {
          label: "−3%",
          ...line(
            idx.map((i) => sma[i]! * 0.97),
            "#8fd19e",
          ),
        },
        {
          label: "−5%",
          ...line(
            idx.map((i) => sma[i]! * 0.95),
            "#3fa65a",
          ),
        },
        {
          label: "−8%",
          ...line(
            idx.map((i) => sma[i]! * 0.92),
            "#1b6e33",
          ),
        },
      ],
    },
    options: {
      title: { display: true, text: `EUR/BRL · ${RANGE_NAME[range]} (faixas verdes: boas épocas)` },
      legend: { position: "bottom", labels: { boxWidth: 12 } },
      scales: { xAxes: [{ ticks: { maxTicksLimit: 8, maxRotation: 0 } }] },
      annotation: { annotations: boxes },
    },
  };
}

/** Pede ao QuickChart uma URL curta da imagem (o Telegram baixa a imagem dessa URL). */
export async function chartUrl(fetchImpl: FetchFn, config: object): Promise<string> {
  const res = await httpJson<{ success: boolean; url?: string }>("https://quickchart.io/chart/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chart: config, width: 900, height: 500, backgroundColor: "white", format: "png" }),
    fetchImpl,
    timeoutMs: 15_000,
  });
  if (!res.success || !res.url) throw new Error("quickchart: não devolveu a URL do gráfico");
  return res.url;
}
