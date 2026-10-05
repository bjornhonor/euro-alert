/**
 * Câmbio real: o EUR/BRL de cada dia corrigido pela inflação do Brasil (IPCA) e da zona do
 * euro, em reais de hoje. Com K(m) = índice IPCA(m) ÷ índice HICP(m):
 *
 *   real(t) = preço(t) × K(hoje) ÷ K(mês de t)
 *
 * Para não reler toda a história a cada coleta, cada fechamento guarda o valor "deflacionado"
 * d(t) = preço(t) ÷ K(mês de t), que não muda depois que a inflação do mês sai. Aí:
 *
 *   média real = K(hoje) × média(d)    e    real(t) > preço de hoje  ⇔  d(t) > preço ÷ K(hoje)
 */
import { mean } from "./indicators";

export interface MonthlyObs {
  date: string; // 'YYYY-MM-01' (ou qualquer data do mês)
  value: number;
}

const monthOf = (date: string) => date.slice(0, 7);

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Completa os meses ainda não publicados até `untilMonth` repetindo a variação mensal média
 * dos últimos 12 meses conhecidos (erro típico de ~0,1% no câmbio real).
 */
export function extendIndex(index: Map<string, number>, untilMonth: string): Map<string, number> {
  const months = [...index.keys()].sort();
  const out = new Map(months.map((m) => [m, index.get(m)!]));
  let last = months.at(-1);
  if (!last || last >= untilMonth) return out;
  const yearAgo = months.at(-13);
  const monthly = yearAgo ? (index.get(last)! / index.get(yearAgo)!) ** (1 / 12) : 1;
  while (last < untilMonth) {
    const next = nextMonth(last);
    out.set(next, out.get(last)! * monthly);
    last = next;
  }
  return out;
}

/** IPCA mensal em % (SGS 433) → índice acumulado (base 100 antes do primeiro mês). */
export function ipcaIndex(obs: readonly MonthlyObs[]): Map<string, number> {
  const sorted = [...obs].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map<string, number>();
  let level = 100;
  for (const o of sorted) {
    level *= 1 + o.value / 100;
    out.set(monthOf(o.date), level);
  }
  return out;
}

/** Índice HICP (já vem em nível) → mapa por mês. */
export function hicpIndex(obs: readonly MonthlyObs[]): Map<string, number> {
  return new Map(obs.map((o) => [monthOf(o.date), o.value]));
}

/** K(m) = IPCA(m) ÷ HICP(m), para todos os meses até `untilMonth` (completando os que faltam). */
export function kByMonth(
  ipca: readonly MonthlyObs[],
  hicp: readonly MonthlyObs[],
  untilMonth: string,
): Map<string, number> {
  const br = extendIndex(ipcaIndex(ipca), untilMonth);
  const eu = extendIndex(hicpIndex(hicp), untilMonth);
  const out = new Map<string, number>();
  for (const [m, v] of br) {
    const e = eu.get(m);
    if (e !== undefined) out.set(m, v / e);
  }
  return out;
}

export interface RealContext {
  /** Média do câmbio real desde o início da série, em reais de hoje. */
  mean: number;
  /** Preço de hoje ÷ média real − 1. */
  dist: number;
  /** Fração dos dias da história mais caros que hoje, em reais de hoje. */
  cheaperThan: number;
  days: number;
}

/**
 * Contexto histórico do preço de hoje. `deflated` são os d(t) dos dias anteriores; o dia de hoje
 * entra na conta com d = preço ÷ K(hoje), como na pesquisa (research/analise_v10.py).
 */
export function realContext(deflated: readonly number[], price: number, kToday: number): RealContext {
  const today = price / kToday;
  const all = [...deflated, today];
  let above = 0;
  for (const d of all) if (d > today) above++;
  const m = kToday * mean(all);
  return { mean: m, dist: price / m - 1, cheaperThan: above / all.length, days: all.length };
}

/** Câmbio real de cada dia (reais do último mês de `k`), para gráficos e testes. */
export function realSeries(
  dates: readonly string[],
  prices: readonly number[],
  k: Map<string, number>,
): number[] {
  const kLast = k.get(monthOf(dates.at(-1)!))!;
  return prices.map((p, i) => (p * kLast) / k.get(monthOf(dates[i]!))!);
}
