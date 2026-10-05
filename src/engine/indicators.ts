/**
 * Funções puras sobre séries (number[], do mais antigo para o mais novo). Todas calculam o
 * valor no índice `i` usando só dados até `i` (sem olhar o futuro), com a mesma convenção do
 * pandas usado na pesquisa: janelas incluem o próprio dia, desvio padrão amostral (ddof = 1).
 * Devolvem NaN quando ainda não há dados suficientes.
 */

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Desvio padrão amostral (ddof = 1). */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Janela de `n` pontos terminando em `i` (inclusive), ou undefined se não couber. */
export function windowAt(xs: readonly number[], n: number, i = xs.length - 1): number[] | undefined {
  if (i < n - 1 || i >= xs.length) return undefined;
  return xs.slice(i - n + 1, i + 1);
}

export function smaAt(xs: readonly number[], n: number, i = xs.length - 1): number {
  const w = windowAt(xs, n, i);
  return w ? mean(w) : NaN;
}

export function stdAt(xs: readonly number[], n: number, i = xs.length - 1): number {
  const w = windowAt(xs, n, i);
  return w ? stdev(w) : NaN;
}

/** z-score do ponto `i` contra a média e o desvio dos últimos `n` pontos. */
export function zScoreAt(xs: readonly number[], n: number, i = xs.length - 1): number {
  return (xs[i]! - smaAt(xs, n, i)) / stdAt(xs, n, i);
}

/**
 * Percentil do ponto `i` na janela, como `rolling(n).rank(pct=True)` do pandas:
 * posto médio (empates dividem o posto) dividido pelo tamanho da janela.
 */
export function rankPctAt(xs: readonly number[], n: number, i = xs.length - 1): number {
  const w = windowAt(xs, n, i);
  if (!w) return NaN;
  const x = xs[i]!;
  let less = 0;
  let equal = 0;
  for (const v of w) {
    if (v < x) less++;
    else if (v === x) equal++;
  }
  return (less + (equal + 1) / 2) / n;
}

/** Fração dos dias da janela mais caros que o ponto `i` ("mais barato que X% dos dias"). */
export function cheaperThanAt(xs: readonly number[], n: number, i = xs.length - 1): number {
  const w = windowAt(xs, n, i);
  if (!w) return NaN;
  const x = xs[i]!;
  let above = 0;
  for (const v of w) if (v > x) above++;
  return above / n;
}

/** Retorno em log de `k` dias até `i`. */
export function logReturnAt(xs: readonly number[], k: number, i = xs.length - 1): number {
  if (i - k < 0) return NaN;
  return Math.log(xs[i]! / xs[i - k]!);
}

/** Volatilidade realizada: desvio dos retornos diários em log nos últimos `n` dias (não anualizada). */
export function volatilityAt(xs: readonly number[], n: number, i = xs.length - 1): number {
  if (i < n) return NaN;
  const r: number[] = [];
  for (let j = i - n + 1; j <= i; j++) r.push(Math.log(xs[j]! / xs[j - 1]!));
  return stdev(r);
}

/**
 * RSI de Wilder, como `ewm(alpha=1/14, adjust=False)` do pandas sobre ganhos e perdas.
 * Depende da série inteira até `i` (o peso do passado cai para 1e-13 em ~400 dias).
 */
export function rsiAt(xs: readonly number[], period = 14, i = xs.length - 1): number {
  if (i < 1) return NaN;
  const a = 1 / period;
  let gain = Math.max(xs[1]! - xs[0]!, 0);
  let loss = Math.max(xs[0]! - xs[1]!, 0);
  for (let j = 2; j <= i; j++) {
    const d = xs[j]! - xs[j - 1]!;
    gain = (1 - a) * gain + a * Math.max(d, 0);
    loss = (1 - a) * loss + a * Math.max(-d, 0);
  }
  return 100 - 100 / (1 + gain / loss);
}

export const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
