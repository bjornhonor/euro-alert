import { EXIT_LEVEL, type Level, LEVEL_RANK, levelFor, LEVELS, YEAR } from "../engine/epoch";

export interface HistoricalEpoch {
  start: string; // data de abertura
  end: string | null; // null = ainda aberta
  entryPrice: number;
  /** Distância da média de 12 meses e nível no dia da abertura. */
  entryDist: number;
  entryLevel: Level;
  /** Menor preço do episódio, a distância da média nesse dia e a data. */
  minPrice: number;
  minDist: number;
  minDate: string;
  maxLevel: Level;
  /** Dias úteis de duração (até o fechamento ou o último dia da série). */
  days: number;
}

/**
 * Épocas históricas a partir dos fechamentos diários, com a mesma regra dos alertas
 * (abre em −3% da média de 250 dias úteis, fecha em −1%), sem a confirmação de 2 leituras
 * (que só faz sentido de 15 em 15 minutos). Igual a `episodes()` em research/analise_v8.py.
 */
export function historicalEpochs(dates: readonly string[], prices: readonly number[]): HistoricalEpoch[] {
  const out: HistoricalEpoch[] = [];
  let sum = 0;
  let cur: HistoricalEpoch | null = null;
  let startIdx = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i]!;
    if (i >= YEAR) sum -= prices[i - YEAR]!;
    if (i < YEAR - 1) continue;
    const p = prices[i]!;
    const dist = p / (sum / YEAR) - 1;
    if (!cur && dist <= LEVELS.boa) {
      cur = {
        start: dates[i]!,
        end: null,
        entryPrice: p,
        entryDist: dist,
        entryLevel: levelFor(dist)!,
        minPrice: p,
        minDist: dist,
        minDate: dates[i]!,
        maxLevel: levelFor(dist)!,
        days: 1,
      };
      startIdx = i;
    } else if (cur) {
      cur.days = i - startIdx + 1;
      if (p < cur.minPrice) Object.assign(cur, { minPrice: p, minDist: dist, minDate: dates[i]! });
      const lvl = levelFor(dist);
      if (lvl && LEVEL_RANK[lvl] > LEVEL_RANK[cur.maxLevel]) cur.maxLevel = lvl;
      if (dist >= EXIT_LEVEL) {
        cur.end = dates[i]!;
        out.push(cur);
        cur = null;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}
