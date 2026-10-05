import { type FetchFn, httpJson } from "../lib/http";

export interface FeeQuote {
  amountBrl: number;
  feeBrl: number;
  /** EUR por BRL. */
  rate: number;
  receivedEur: number;
}

/** Tarifa total (Wise + IOF) como reta: fee = fixed + pct × valor. */
export interface FeeModel {
  fixed: number;
  pct: number;
}

/** Valores consultados todo dia para ajustar a reta. */
export const FEE_AMOUNTS = [300, 1000, 3000] as const;
/** Valor de referência mostrado nos alertas. */
export const REFERENCE_AMOUNT = 1000;

interface ComparisonResponse {
  providers?: { alias: string; quotes?: { fee: number; rate: number; receivedAmount: number }[] }[];
}

export function parseComparison(data: ComparisonResponse, amountBrl: number): FeeQuote | undefined {
  const q = data.providers?.find((p) => p.alias === "wise")?.quotes?.[0];
  if (!q || !(q.rate > 0)) return undefined;
  return { amountBrl, feeBrl: q.fee, rate: q.rate, receivedEur: q.receivedAmount };
}

/** Comparação pública da Wise (sem token; o robots.txt libera esse caminho). */
export async function fetchFeeQuote(fetchImpl: FetchFn, amountBrl: number): Promise<FeeQuote | undefined> {
  const url = `https://api.wise.com/v3/comparisons/?sourceCurrency=BRL&targetCurrency=EUR&sendAmount=${amountBrl}`;
  return parseComparison(await httpJson<ComparisonResponse>(url, { fetchImpl, timeoutMs: 8_000 }), amountBrl);
}

/** Mínimos quadrados de fee contra valor. Precisa de pelo menos dois valores diferentes. */
export function fitFeeModel(quotes: readonly FeeQuote[]): FeeModel | undefined {
  if (quotes.length < 2) return undefined;
  const n = quotes.length;
  const mx = quotes.reduce((s, q) => s + q.amountBrl, 0) / n;
  const my = quotes.reduce((s, q) => s + q.feeBrl, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const q of quotes) {
    sxx += (q.amountBrl - mx) ** 2;
    sxy += (q.amountBrl - mx) * (q.feeBrl - my);
  }
  if (sxx === 0) return undefined;
  const pct = sxy / sxx;
  return { fixed: my - pct * mx, pct };
}

export function feeFor(model: FeeModel, amountBrl: number): number {
  return model.fixed + model.pct * amountBrl;
}

/**
 * Custo efetivo de 1 euro na Wise: quanto sai em reais, já com tarifa e IOF.
 * recebido = (valor − fee) × taxa  →  R$/€ = valor / recebido.
 */
export function effectiveBrlPerEur(model: FeeModel, eurBrlMid: number, amountBrl = REFERENCE_AMOUNT): number {
  const received = (amountBrl - feeFor(model, amountBrl)) / eurBrlMid;
  return amountBrl / received;
}
