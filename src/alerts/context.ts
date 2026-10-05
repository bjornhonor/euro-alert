import events from "../../config/events.json";
import { type Signal } from "../engine/signal";
import { effectiveBrlPerEur, type FeeModel, REFERENCE_AMOUNT } from "../providers/wise-fees";
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

/** Linhas de contexto do alerta (tudo derivado do preço do euro, mais calendário). */
export function contextLines(signal: Signal, today: string): string[] {
  const e = signal.epoch;
  const lines: string[] = [];
  lines.push(
    `Média de 12 meses ${e.slope250 < 0 ? "caindo" : "subindo"} (${pct(e.slope250, 1, true)} em 3 meses)` +
      (e.slope250 < 0 ? ": euro em tendência de queda" : ""),
  );
  const above = [e.aboveSma20, e.aboveSma50];
  lines.push(
    above.every(Boolean)
      ? "Preço acima das médias de 20 e 50 dias"
      : above.some(Boolean)
        ? `Preço ${e.aboveSma20 ? "acima" : "abaixo"} da média de 20 dias e ${e.aboveSma50 ? "acima" : "abaixo"} da de 50`
        : "Preço abaixo das médias de 20 e 50 dias",
  );
  const d = signal.decomposition.find((x) => x.days === 5) ?? signal.decomposition[0];
  if (d) {
    const fromReal = Math.abs(d.usdbrl) >= Math.abs(d.eurusd);
    lines.push(
      fromReal
        ? `Movimento veio do real (USD/BRL ${pct(d.usdbrl, 1, true)} em ${d.days} ${d.days === 1 ? "dia" : "dias"})`
        : `Movimento veio do euro lá fora (EUR/USD ${pct(d.eurusd, 1, true)} em ${d.days} ${d.days === 1 ? "dia" : "dias"})`,
    );
  }
  const s = signal.seasonal;
  if (s && Math.abs(s.mean) >= 0.3) {
    lines.push(
      `${capitalize(MONTH_NAME[s.month]!)} costuma ficar ${num(Math.abs(s.mean), 1)}% ${s.mean < 0 ? "abaixo" : "acima"} da tendência (${s.n} anos)`,
    );
  }
  for (const ev of upcomingEvents(today)) {
    lines.push(`${ev.title} ${ev.days === 0 ? "hoje" : ev.days === 1 ? "amanhã" : `em ${ev.days} dias`}`);
  }
  return lines;
}

/** "Custo na Wise: ~R$ 5,82/€ (tarifa + IOF, para R$ 1.000)". */
export function wiseCostLine(model: FeeModel | undefined, price: number): string | undefined {
  if (!model) return undefined;
  return `Custo na Wise: ~R$ ${num(effectiveBrlPerEur(model, price))}/€ (tarifa + IOF, para R$ ${REFERENCE_AMOUNT.toLocaleString("pt-BR")})`;
}

/** Os três horizontes, uma linha cada. */
export function horizonLines(signal: Signal): string[] {
  const e = signal.epoch;
  const lines = [
    `12 meses: ${aboveBelow(e.dist250)} da média (${num(e.sma250, 4)}) · mais barato que ${pct(e.pct250, 0)} dos dias`,
    `5 anos: ${aboveBelow(e.dist1260)} da média (${num(e.sma1260, 4)}) · mais barato que ${pct(e.pct1260, 0)} dos dias`,
  ];
  if (signal.real) {
    lines.push(
      `História (desde 2002, corrigida pela inflação): ${aboveBelow(signal.real.dist)} da média (${num(signal.real.mean, 4)})`,
    );
  }
  return lines;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
