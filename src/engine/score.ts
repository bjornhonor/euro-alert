import { clip, logReturnAt, rankPctAt, rsiAt, volatilityAt, zScoreAt } from "./indicators";

/**
 * Score de curto prazo (0–100), só contexto, nunca gatilho. Mesmos componentes e pesos da
 * pesquisa (`indicators()` em research/analise_preliminar.py): 35/25/15/15, normalizados por 0,90.
 */
export const SCORE_WEIGHTS = { percentil: 0.35, distancia: 0.25, rsi: 0.15, queda: 0.15 } as const;

export interface ScoreResult {
  score: number;
  z20: number;
  pct90: number;
  rsi: number;
  sd60: number;
  ret5: number;
  components: { percentil: number; distancia: number; rsi: number; queda: number };
}

export function scoreAt(prices: readonly number[], i = prices.length - 1): ScoreResult {
  const z20 = zScoreAt(prices, 20, i);
  const pct90 = rankPctAt(prices, 90, i);
  const rsi = rsiAt(prices, 14, i);
  const sd60 = volatilityAt(prices, 60, i);
  const ret5 = logReturnAt(prices, 5, i);
  const components = {
    percentil: 1 - pct90,
    distancia: clip(-z20 / 2.5, 0, 1),
    rsi: clip((50 - rsi) / 20, 0, 1),
    queda: clip(-ret5 / (1.5 * sd60 * Math.sqrt(5)), 0, 1),
  };
  const w = SCORE_WEIGHTS;
  const total = w.percentil + w.distancia + w.rsi + w.queda;
  const score =
    (100 *
      (w.percentil * components.percentil +
        w.distancia * components.distancia +
        w.rsi * components.rsi +
        w.queda * components.queda)) /
    total;
  return { score, z20, pct90, rsi, sd60, ret5, components };
}
