import events from "../../config/events.json";
import { type Signal } from "../engine/signal";
import { effectiveBrlPerEur, type FeeModel } from "../providers/wise-fees";
import { aboveBelow, MONTH_NAME, num, pct } from "./format";

export interface UpcomingEvent {
  date: string;
  title: string;
  days: number;
}

/** Eventos dos próximos `horizon` dias (lista mantida à mão em config/events.json). */
export function upcomingEvents(today: string, horizon = 14): UpcomingEvent[] {
  const t0 = Date.parse(`${today}T00:00:00Z`);
  return events
    .map((e) => ({ ...e, days: Math.round((Date.parse(`${e.date}T00:00:00Z`) - t0) / 86_400_000) }))
    .filter((e) => e.days >= 0 && e.days <= horizon);
}

/**
 * Pontos de atenção do alerta, curtos (tudo derivado do preço do euro, mais calendário).
 * As médias de 20 e 50 dias ficam de fora: são detalhe técnico, a IA comenta se importar.
 */
export function contextLines(signal: Signal, today: string): string[] {
  const e = signal.epoch;
  const lines: string[] = [];
  lines.push(e.slope250 < 0 ? "Euro em tendência de queda" : "Euro em tendência de alta");
  const d = signal.decomposition.find((x) => x.days === 5) ?? signal.decomposition[0];
  if (d) lines.push(`${originOf(d)} em ${d.days} ${d.days === 1 ? "dia" : "dias"}`);
  const s = signal.seasonal;
  if (s && Math.abs(s.mean) >= 0.3) {
    lines.push(
      `${capitalize(MONTH_NAME[s.month]!)} costuma ficar ${num(Math.abs(s.mean), 1)}% ${s.mean < 0 ? "abaixo" : "acima"} da tendência`,
    );
  }
  for (const ev of upcomingEvents(today)) {
    lines.push(`${ev.title} ${ev.days === 0 ? "hoje" : ev.days === 1 ? "amanhã" : `em ${ev.days} dias`}`);
  }
  return lines;
}

/** "Puxado pelo real (USD/BRL −2,1%)" ou "Puxado pelo euro lá fora (EUR/USD +1,0%)". */
export function originOf(d: { usdbrl: number; eurusd: number }): string {
  return Math.abs(d.usdbrl) >= Math.abs(d.eurusd)
    ? `Puxado pelo real (USD/BRL ${pct(d.usdbrl, 1, true)})`
    : `Puxado pelo euro lá fora (EUR/USD ${pct(d.eurusd, 1, true)})`;
}

/** "💳 Na Wise: ~R$ 6,11 por euro, com tarifa e IOF" (custo calculado para R$ 1.000). */
export function wiseCostLine(model: FeeModel | undefined, price: number): string | undefined {
  if (!model) return undefined;
  return `💳 Na Wise: ~R$ ${num(effectiveBrlPerEur(model, price))} por euro, com tarifa e IOF`;
}

/** Os horizontes longos, para comparar com o de 12 meses (que é o gatilho). */
export function comparisonLines(signal: Signal): string[] {
  const lines = [`5 anos: ${aboveBelow(signal.epoch.dist1260)} da média`];
  if (signal.real) lines.push(`Desde 2002: ${aboveBelow(signal.real.dist)} (já descontada a inflação)`);
  return lines;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
