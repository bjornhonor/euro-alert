import { type FetchFn, httpJson } from "../lib/http";

export interface Observation {
  date: string; // 'YYYY-MM-DD'
  value: number;
}

export const SGS = { selic: 432, ipca: 433 } as const;

/** 'dd/MM/aaaa' → 'YYYY-MM-DD' */
export function brDateToIso(d: string): string {
  const [dd, mm, yyyy] = d.split("/");
  return `${yyyy}-${mm}-${dd}`;
}

export function isoToBrDate(iso: string): string {
  const [yyyy, mm, dd] = iso.split("-");
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Converte a resposta do SGS e descarta datas futuras: a série da Selic meta vem
 * preenchida até a próxima reunião do Copom.
 */
export function parseSgs(rows: { data: string; valor: string }[], today: string): Observation[] {
  if (!Array.isArray(rows)) throw new Error("sgs: resposta não é uma lista");
  return rows
    .map((r) => ({ date: brDateToIso(r.data), value: Number(r.valor) }))
    .filter((o) => o.date <= today && Number.isFinite(o.value));
}

/** Séries diárias aceitam no máximo 10 anos por consulta. Datas em 'YYYY-MM-DD'. */
export async function fetchSgs(
  fetchImpl: FetchFn,
  series: number,
  from: string,
  to: string,
  today: string,
): Promise<Observation[]> {
  const url =
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series}/dados?formato=json` +
    `&dataInicial=${isoToBrDate(from)}&dataFinal=${isoToBrDate(to)}`;
  const rows = await httpJson<{ data: string; valor: string }[]>(url, { fetchImpl, timeoutMs: 15_000 });
  return parseSgs(rows, today);
}

interface FocusRow {
  Indicador: string;
  Data: string;
  DataReferencia: string;
  Mediana: number;
}

/**
 * Expectativa Focus para o câmbio (dólar, fim de ano). A URL precisa ir codificada
 * (%20 e o acento de "Câmbio"), senão a API responde 400.
 */
export const FOCUS_URL =
  "https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoAnuais" +
  "?$top=4&$filter=Indicador%20eq%20'C%C3%A2mbio'&$orderby=Data%20desc&$format=json";

export function parseFocus(data: { value?: FocusRow[] }): { year: string; date: string; median: number }[] {
  return (data.value ?? [])
    .filter((r) => r.Indicador.startsWith("C") && Number.isFinite(r.Mediana)) // o filtro da URL já pede só "Câmbio"
    .map((r) => ({ year: r.DataReferencia, date: r.Data, median: r.Mediana }));
}

export async function fetchFocus(fetchImpl: FetchFn) {
  return parseFocus(await httpJson<{ value?: FocusRow[] }>(FOCUS_URL, { fetchImpl, timeoutMs: 15_000 }));
}
