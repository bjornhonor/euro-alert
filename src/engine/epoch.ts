import { cheaperThanAt, smaAt } from "./indicators";

/** Janelas em dias úteis. */
export const YEAR = 250;
export const FIVE_YEARS = 1260;
export const QUARTER = 63;

/** Níveis da boa época (seção 3.1 do plano): distância da média de 12 meses. */
export const LEVELS = { boa: -0.03, muito_boa: -0.05, rara: -0.08 } as const;
/** Saída da boa época (histerese): só termina quando a distância volta acima disso. */
export const EXIT_LEVEL = -0.01;

export type Level = keyof typeof LEVELS;

export function levelFor(dist250: number): Level | null {
  if (!(dist250 <= LEVELS.boa)) return null;
  if (dist250 <= LEVELS.rara) return "rara";
  if (dist250 <= LEVELS.muito_boa) return "muito_boa";
  return "boa";
}

export interface EpochMetrics {
  price: number;
  /** Preço ÷ média de 250 dias úteis − 1 (gatilho). */
  dist250: number;
  sma250: number;
  /** Fração dos últimos 250 dias mais caros que hoje. */
  pct250: number;
  dist1260: number;
  sma1260: number;
  pct1260: number;
  /** Variação da média de 12 meses nos últimos 63 dias úteis (tendência). */
  slope250: number;
  aboveSma20: boolean;
  aboveSma50: boolean;
  level: Level | null;
}

/** Métricas da boa época no ponto `i` (o último, por padrão). */
export function epochAt(prices: readonly number[], i = prices.length - 1): EpochMetrics {
  const p = prices[i]!;
  const sma250 = smaAt(prices, YEAR, i);
  const sma1260 = smaAt(prices, FIVE_YEARS, i);
  const dist250 = p / sma250 - 1;
  return {
    price: p,
    dist250,
    sma250,
    pct250: cheaperThanAt(prices, YEAR, i),
    dist1260: p / sma1260 - 1,
    sma1260,
    pct1260: cheaperThanAt(prices, FIVE_YEARS, i),
    slope250: sma250 / smaAt(prices, YEAR, i - QUARTER) - 1,
    aboveSma20: p > smaAt(prices, 20, i),
    aboveSma50: p > smaAt(prices, 50, i),
    level: levelFor(dist250),
  };
}
