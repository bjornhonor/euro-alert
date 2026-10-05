/**
 * Decomposição do EUR/BRL e faixas de projeção. Contexto para o alerta e a IA: explicam o
 * movimento do euro, não disparam nada.
 */

export interface Decomposition {
  days: number;
  /** Variações em log (≈ %/100). eurbrl = eurusd + usdbrl. */
  eurbrl: number;
  eurusd: number;
  usdbrl: number;
}

/**
 * Quanto da variação do EUR/BRL em `days` dias veio do euro contra o dólar e quanto do real
 * contra o dólar. Séries alinhadas pela data, do mais antigo ao mais novo.
 */
export function decompose(
  eurusd: readonly number[],
  usdbrl: readonly number[],
  days: number,
): Decomposition | undefined {
  const n = Math.min(eurusd.length, usdbrl.length);
  if (n <= days) return undefined;
  const a = Math.log(eurusd[n - 1]! / eurusd[n - 1 - days]!);
  const b = Math.log(usdbrl[n - 1]! / usdbrl[n - 1 - days]!);
  return { days, eurbrl: a + b, eurusd: a, usdbrl: b };
}

export interface Band {
  days: number;
  low68: number;
  high68: number;
  low95: number;
  high95: number;
}

/** Faixas onde o preço deve ficar em `days` dias úteis, pela volatilidade diária (log) recente. */
export function projectionBand(price: number, dailyVol: number, days: number): Band {
  const s = dailyVol * Math.sqrt(days);
  return {
    days,
    low68: price * Math.exp(-s),
    high68: price * Math.exp(s),
    low95: price * Math.exp(-1.96 * s),
    high95: price * Math.exp(1.96 * s),
  };
}
