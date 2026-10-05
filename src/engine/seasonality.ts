/**
 * Índice sazonal: preço médio de cada mês contra a tendência de 12 meses (média móvel 2×12
 * centrada), em %, com a média por mês do ano. Negativo = mês tipicamente mais barato.
 * Mesmo cálculo de `seasonality()` em research/analise_v6.py.
 */
export interface MonthlyMean {
  month: string; // 'YYYY-MM'
  mean: number;
}

export type SeasonalIndex = Record<number, { mean: number; n: number }>; // 1 = janeiro

export function seasonalIndex(months: readonly MonthlyMean[]): SeasonalIndex {
  const m = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const byMonth = new Map<number, number[]>();
  for (let i = 6; i + 6 < m.length; i++) {
    // (½·x[i−6] + x[i−5..i+5] + ½·x[i+6]) / 12
    let s = 0.5 * m[i - 6]!.mean + 0.5 * m[i + 6]!.mean;
    for (let j = i - 5; j <= i + 5; j++) s += m[j]!.mean;
    const trend = s / 12;
    const cal = Number(m[i]!.month.slice(5, 7));
    const list = byMonth.get(cal) ?? [];
    list.push((m[i]!.mean / trend - 1) * 100);
    byMonth.set(cal, list);
  }
  const out: SeasonalIndex = {};
  for (const [cal, xs] of byMonth)
    out[cal] = { mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length };
  return out;
}
