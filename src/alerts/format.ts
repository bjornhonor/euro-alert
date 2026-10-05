/** Formatação em português do Brasil: vírgula decimal e sinal de menos tipográfico (−). */

export function num(x: number, decimals = 2): string {
  const s = Math.abs(x).toFixed(decimals).replace(".", ",");
  return x < 0 && Number(s.replace(",", ".")) !== 0 ? `−${s}` : s;
}

/** Fração → "3,3%" (com sinal só quando pedido). */
export function pct(x: number, decimals = 1, signed = false): string {
  const v = num(x * 100, decimals);
  return signed && x > 0 ? `+${v}%` : `${v}%`;
}

/** Fração → "3,3% abaixo" / "0,9% acima". */
export function aboveBelow(x: number, decimals = 1): string {
  return `${num(Math.abs(x) * 100, decimals)}% ${x < 0 ? "abaixo" : "acima"}`;
}

export function rate(x: number): string {
  return num(x, 4);
}

/** 'YYYY-MM-DD' → 'dd/mm'. */
export function ddmm(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

export const LEVEL_NAME = { boa: "boa", muito_boa: "muito boa", rara: "rara" } as const;

export const MONTH_NAME = [
  "",
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

export const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;
