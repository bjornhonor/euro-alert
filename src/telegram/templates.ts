import { contextLines, horizonLines, wiseCostLine } from "../alerts/context";
import { aboveBelow, ddmm, LEVEL_NAME, MONTH_NAME, num, pct, rate } from "../alerts/format";
import { type RuleEvent } from "../alerts/rules";
import { type ScoreSummary } from "../alerts/scorecard";
import { type Level } from "../engine/epoch";
import { type Signal } from "../engine/signal";
import { type FeeModel } from "../providers/wise-fees";

/** Tudo que os modelos precisam além do evento. */
export interface MessageContext {
  signal: Signal;
  today: string;
  feeModel?: FeeModel;
  score?: ScoreSummary;
  /** Data de início da época atual (para "desde o início"). */
  epochStart?: { date: string; price: number };
  seasonalIndex?: Record<number, { mean: number; n: number }>;
}

const LEVEL_ICON: Record<Level, string> = { boa: "🟢", muito_boa: "🟢🟢", rara: "🟢🟢🟢" };

/**
 * Junta as linhas. Todo texto aqui é gerado pelo app (números e frases fixas, nada vindo de
 * fora), então pode levar tags HTML do Telegram (<b>) sem escapar.
 */
const esc = (lines: (string | undefined)[]) => lines.filter((l): l is string => l !== undefined).join("\n");

function nextLevels(signal: Signal, level: Level, levels: Record<Level, number>): string | undefined {
  const order: Level[] = ["boa", "muito_boa", "rara"];
  const next = order.slice(order.indexOf(level) + 1);
  if (next.length === 0) return undefined;
  const parts = next.map((l) => `${pct(levels[l], 0)} (${num(signal.epoch.sma250 * (1 + levels[l]))})`);
  return `${parts.length > 1 ? "próximos" : "próximo"}: ${parts.join(" e ")}`;
}

function scoreLine(score?: ScoreSummary): string | undefined {
  if (!score || score.measured < 2) return undefined;
  return (
    `Placar (${score.measured} épocas nos últimos 5 anos): no início, o preço ficou em média ` +
    `${aboveBelow(score.vsNext3m)} da média dos 3 meses seguintes (abaixo em ${pct(score.hitRate, 0)} das vezes); ` +
    `depois o euro ainda caiu em média ${pct(Math.abs(score.furtherDrop))}.`
  );
}

/** Texto do alerta em HTML do Telegram. */
export function renderAlert(ev: RuleEvent, ctx: MessageContext, levels: Record<Level, number>): string {
  const s = ctx.signal;
  const price = rate(s.epoch.price);
  switch (ev.kind) {
    case "epoca_inicio":
      return esc([
        `${LEVEL_ICON[ev.level]} <b>Boa época</b> · EUR/BRL ${price}`,
        ...horizonLines(s),
        `Nível: ${LEVEL_NAME[ev.level]}${nextLevels(s, ev.level, levels) ? ` · ${nextLevels(s, ev.level, levels)}` : ""}`,
        "",
        "<b>Contexto</b>",
        ...contextLines(s, ctx.today).map((l) => `• ${l}`),
        "",
        scoreLine(ctx.score),
        wiseCostLine(ctx.feeModel, s.epoch.price),
      ]);
    case "epoca_nivel": {
      const since = ctx.epochStart
        ? `Desde o início (${ddmm(ctx.epochStart.date)}): ${pct(s.epoch.price / ctx.epochStart.price - 1, 1, true)}`
        : undefined;
      return esc([
        `${LEVEL_ICON[ev.level]} <b>Boa época ficou melhor</b> · EUR/BRL ${price}`,
        `12 meses: ${aboveBelow(s.epoch.dist250)} da média · nível: ${LEVEL_NAME[ev.level]}`,
        `5 anos: ${aboveBelow(s.epoch.dist1260)} da média` +
          (s.real ? ` · história: ${aboveBelow(s.real.dist)} (corrigida pela inflação)` : ""),
        since,
        nextLevels(s, ev.level, levels)
          ? `Nível seguinte: ${nextLevels(s, ev.level, levels)!.replace(/^próximos?: /, "")}`
          : undefined,
        wiseCostLine(ctx.feeModel, s.epoch.price),
      ]);
    }
    case "epoca_fim": {
      const start = new Date(ev.startTs - 3 * 3600_000).toISOString().slice(0, 10);
      const minDate = new Date(ev.minTs - 3 * 3600_000).toISOString().slice(0, 10);
      return esc([
        `⚪ <b>Boa época terminou</b> · EUR/BRL ${price}`,
        `Voltou para ${pct(s.epoch.dist250, 1, true)} da média de 12 meses`,
        `Começou em ${ddmm(start)} a ${rate(ev.entryPrice)} · ponto mais baixo ${rate(ev.minPrice)} ` +
          `(${pct(ev.minDist, 1, true)}) em ${ddmm(minDate)} · chegou ao nível ${LEVEL_NAME[ev.levelReached]}`,
      ]);
    }
    case "disparada": {
      const d = s.decomposition.find((x) => x.days === 5);
      return esc([
        `🔺 <b>Euro disparando</b> · EUR/BRL ${price} (${pct(Math.exp(ev.ret5) - 1, 1, true)} em 5 dias)`,
        d
          ? Math.abs(d.usdbrl) >= Math.abs(d.eurusd)
            ? `Movimento veio do real (USD/BRL ${pct(d.usdbrl, 1, true)})`
            : `Movimento veio do euro lá fora (EUR/USD ${pct(d.eurusd, 1, true)})`
          : undefined,
        `${aboveBelow(s.epoch.dist250)} da média de 12 meses`,
      ]);
    }
    case "sazonal": {
      const idx = ctx.seasonalIndex?.[ev.month];
      const media = idx
        ? ` (em média ${num(Math.abs(idx.mean), 1)}% ${idx.mean < 0 ? "abaixo" : "acima"} da tendência, ${idx.n} anos)`
        : "";
      return esc([
        ev.month === 12
          ? `🗓️ <b>Dezembro começou</b>: historicamente o mês mais caro do ano pro euro${media}. Janeiro e fevereiro costumam aliviar.`
          : `🗓️ <b>Junho começou</b>: começo do período que costuma ser mais barato pro euro (junho e julho)${media}.`,
      ]);
    }
  }
}

/** Título curto, para a lista de alertas retidos no resumo das 8h. */
export function alertTitle(ev: RuleEvent): string {
  switch (ev.kind) {
    case "epoca_inicio":
      return `Boa época começou (${LEVEL_NAME[ev.level]})`;
    case "epoca_nivel":
      return `Boa época ficou melhor (${LEVEL_NAME[ev.level]})`;
    case "epoca_fim":
      return "Boa época terminou";
    case "disparada":
      return `Euro disparando (${pct(Math.exp(ev.ret5) - 1, 1, true)} em 5 dias)`;
    case "sazonal":
      return `${MONTH_NAME[ev.month]} começou`;
  }
}

/** Botões do alerta. callback_data tem no máximo 64 bytes. */
export function alertButtons(alertId: number) {
  return {
    inline_keyboard: [
      [
        { text: "🤖 Análise", callback_data: `ai:${alertId}` },
        { text: "📈 Gráfico", callback_data: `chart:${alertId}` },
        { text: "🔕 24h", callback_data: "mute:24h" },
      ],
    ],
  };
}
