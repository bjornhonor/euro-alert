import { BROWSER_USER_AGENT, type FetchFn, http, httpJson } from "../lib/http";
import { type Observation } from "./bcb";

/**
 * Taxa de depósito do BCE (só as datas de mudança). A API do BCE é instável:
 * quem chama guarda em cache e tolera falha.
 */
export const ECB_DFR_URL =
  "https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?lastNObservations=3&format=csvdata";

/** CSV do BCE: acha as colunas TIME_PERIOD e OBS_VALUE pelo cabeçalho. */
export function parseEcbCsv(csv: string): Observation[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]?.split(",") ?? [];
  const iDate = header.indexOf("TIME_PERIOD");
  const iValue = header.indexOf("OBS_VALUE");
  if (iDate < 0 || iValue < 0) throw new Error("ecb: CSV sem TIME_PERIOD/OBS_VALUE");
  return lines
    .slice(1)
    .map((line) => line.split(","))
    .map((cols) => ({ date: cols[iDate] ?? "", value: Number(cols[iValue]) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && Number.isFinite(o.value));
}

export async function fetchEcbDepositRate(fetchImpl: FetchFn): Promise<Observation[]> {
  const res = await http(ECB_DFR_URL, { fetchImpl, userAgent: BROWSER_USER_AGENT, timeoutMs: 15_000 });
  return parseEcbCsv(await res.text());
}

/**
 * Inflação harmonizada da zona do euro (índice 2025 = 100), série nova da Eurostat
 * (`prc_hicp_minr`). Tem o histórico inteiro desde 1996 numa base só; a série antiga
 * (2015 = 100, no BCE e em `prc_hicp_midx`) parou em dez/2025.
 */
export function hicpUrl(sinceMonth?: string): string {
  const base =
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr" +
    "?geo=EA&coicop18=TOTAL&unit=I25";
  return sinceMonth ? `${base}&sinceTimePeriod=${sinceMonth}` : base;
}

interface JsonStat {
  value: Record<string, number>;
  dimension: { time: { category: { index: Record<string, number> } } };
}

/** JSON-stat da Eurostat → observações mensais com data 'YYYY-MM-01'. */
export function parseEurostat(data: JsonStat): Observation[] {
  const index = data.dimension?.time?.category?.index;
  if (!index) throw new Error("eurostat: resposta sem dimensão de tempo");
  return Object.entries(index)
    .filter(([, pos]) => data.value[String(pos)] !== undefined)
    .map(([month, pos]) => ({ date: `${month}-01`, value: data.value[String(pos)]! }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchHicp(fetchImpl: FetchFn, sinceMonth?: string): Promise<Observation[]> {
  return parseEurostat(await httpJson<JsonStat>(hicpUrl(sinceMonth), { fetchImpl, timeoutMs: 20_000 }));
}
