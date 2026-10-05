import { mean } from "../engine/indicators";

/** Janelas do placar, em dias úteis. */
export const WINDOWS = { m1: 21, m3: 63, m6: 126 } as const;

export interface Outcome {
  avg1m: number | null;
  avg3m: number | null;
  avg6m: number | null;
  min3m: number | null;
}

/** Médias e mínimo dos fechamentos depois do alerta; null enquanto a janela não fechou. */
export function outcomeFrom(after: readonly number[]): Outcome {
  const avg = (n: number) => (after.length >= n ? mean(after.slice(0, n)) : null);
  return {
    avg1m: avg(WINDOWS.m1),
    avg3m: avg(WINDOWS.m3),
    avg6m: avg(WINDOWS.m6),
    min3m: after.length >= WINDOWS.m3 ? Math.min(...after.slice(0, WINDOWS.m3)) : null,
  };
}

export interface ScoreSummary {
  epochs: number;
  /** Com os 3 meses seguintes já fechados. */
  measured: number;
  /** Média de (preço no início ÷ média dos 3 meses seguintes − 1). Negativo = comprou abaixo. */
  vsNext3m: number;
  /** Em quantos % das épocas o início ficou abaixo da média dos 3 meses seguintes. */
  hitRate: number;
  /** Média de (mínimo dos 3 meses seguintes ÷ preço no início − 1): quanto ainda caiu depois. */
  furtherDrop: number;
}

export function summarize(
  rows: readonly { price: number; avg3m: number | null; min3m: number | null }[],
): ScoreSummary {
  const done = rows.filter((r) => r.avg3m !== null && r.min3m !== null);
  return {
    epochs: rows.length,
    measured: done.length,
    vsNext3m: mean(done.map((r) => r.price / r.avg3m! - 1)),
    hitRate: done.length ? done.filter((r) => r.price < r.avg3m!).length / done.length : NaN,
    furtherDrop: mean(done.map((r) => r.min3m! / r.price - 1)),
  };
}
