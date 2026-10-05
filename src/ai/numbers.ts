/**
 * Checagem anti-invenção: todo número citado pela IA precisa existir na entrada, do jeito que
 * veio (5,8564), arredondado (5,86) ou como porcentagem (−0,076 → 7,6%). Inteiros pequenos
 * (dias, meses, datas) passam.
 */

/** Todos os números de um objeto, recursivamente. */
export function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

/** Números escritos num texto em português ("7,6%", "5,58", "R$ 6,11"). */
export function numbersInText(text: string): number[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
}

const SMALL_INT = 31;
/** Referências técnicas fixas que a IA pode citar: médias de 20/50/250 dias, níveis do RSI, escala 0–100. */
const TECHNICAL = new Set([20, 30, 50, 60, 70, 80, 100, 250]);

/**
 * Cada número da entrada vira os valores aceitos no texto, com a tolerância do arredondamento:
 * frações (|v| ≤ 1,5) como porcentagem com 1 casa (−0,0765 → 7,6 ou 7,7); preços e afins
 * (até 10) com 2 casas (5,8564 → 5,86); o resto (RSI, score) inteiro.
 */
function acceptedValues(input: unknown): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of numbersIn(input)) {
    const v = Math.abs(raw);
    if (v <= 1.5) out.push([v * 100, 0.051], [v, 0.0051]);
    else if (v < 10) out.push([v, 0.0051]);
    else out.push([v, 0.51]);
  }
  return out;
}

export function unknownNumbers(texts: readonly string[], input: unknown): number[] {
  const accepted = acceptedValues(input);
  const ok = (x: number) => {
    if (Number.isInteger(x) && x <= SMALL_INT) return true; // dias, meses, datas
    if (Number.isInteger(x) && x >= 2000 && x <= 2100) return true; // anos
    if (TECHNICAL.has(x)) return true;
    return accepted.some(([a, tol]) => Math.abs(a - x) <= tol);
  };
  return texts.flatMap(numbersInText).filter((x) => !ok(x));
}
