export type Pair = "EURBRL" | "USDBRL" | "EURUSD";
export type QuoteSource = "wise-api" | "wise-public" | "awesomeapi";

export interface Quote {
  pair: Pair;
  mid: number;
  bid?: number;
  ask?: number;
  /** Momento da cotação na fonte (epoch ms). */
  ts: number;
  source: QuoteSource;
}

/** Fonte de cotação ao vivo. Devolve só os pares que conseguir; erro de rede vira exceção. */
export interface RateProvider {
  name: QuoteSource;
  pairs: readonly Pair[];
  latest(pairs: readonly Pair[]): Promise<Quote[]>;
}

/** Faixa plausível por par: descarta lixo (0, NaN, unidade errada) antes de qualquer outra regra. */
const PLAUSIBLE: Record<Pair, [number, number]> = {
  EURBRL: [2, 15],
  USDBRL: [1.5, 12],
  EURUSD: [0.7, 1.8],
};

export function isPlausible(q: Quote): boolean {
  const [lo, hi] = PLAUSIBLE[q.pair];
  return Number.isFinite(q.mid) && q.mid >= lo && q.mid <= hi && Number.isFinite(q.ts);
}
