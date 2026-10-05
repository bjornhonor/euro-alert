/** Brasília não tem horário de verão desde 2019: UTC−3 o ano todo. */
export const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

/** Relógio injetável: os testes passam um horário fixo. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(ms: number): Clock {
  return { now: () => ms };
}

export interface BrtParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = domingo … 6 = sábado
  date: string; // 'YYYY-MM-DD'
}

export function brt(ms: number): BrtParts {
  const d = new Date(ms + BRT_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year,
    month,
    day,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Segunda a sexta no horário de Brasília. O câmbio global não fecha em feriado brasileiro. */
export function isWeekday(ms: number): boolean {
  const { weekday } = brt(ms);
  return weekday >= 1 && weekday <= 5;
}

/** Janela em que alertas podem tocar o celular (padrão 8h–22h, dias úteis). Fora dela vão para o resumo das 8h. */
export function isAlertWindow(ms: number, startHour: number, endHour: number): boolean {
  if (!isWeekday(ms)) return false;
  const { hour } = brt(ms);
  return hour >= startHour && hour < endHour;
}

/**
 * Câmbio global aberto: fecha sexta 17h de Nova York (18h em Brasília) e reabre domingo
 * à noite (segunda 9h em Auckland ≈ domingo 18h–19h em Brasília). Usa 19h para não
 * acusar falta de dados na meia hora de abertura.
 */
export function isFxMarketOpen(ms: number): boolean {
  const { weekday, hour } = brt(ms);
  if (weekday >= 1 && weekday <= 4) return true;
  if (weekday === 5) return hour < 18;
  if (weekday === 0) return hour >= 19;
  return false;
}

/** Início e fim (exclusivo) de um dia de Brasília, em epoch ms UTC. */
export function brtDayBounds(date: string): [number, number] {
  const start = Date.parse(`${date}T00:00:00Z`) - BRT_OFFSET_MS;
  return [start, start + 24 * 60 * 60 * 1000];
}

/** Soma dias a uma data 'YYYY-MM-DD'. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function isWeekdayDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
}

/** Arredonda para baixo no múltiplo de 15 min (chave de `rates.ts`). */
export function floorTo15Min(ms: number): number {
  return ms - (ms % QUARTER_HOUR_MS);
}
