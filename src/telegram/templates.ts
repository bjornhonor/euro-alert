import { comparisonLines, contextLines, originOf, wiseCostLine } from "../alerts/context";
import { aboveBelow, ddmm, LEVEL_NAME, MONTH_NAME, num, pct, rate } from "../alerts/format";
import { type RuleEvent } from "../alerts/rules";
import { type Level } from "../engine/epoch";
import { type Signal } from "../engine/signal";
import { type FeeModel } from "../providers/wise-fees";

/** Tudo que os modelos precisam além do evento. */
export interface MessageContext {
  signal: Signal;
  today: string;
  feeModel?: FeeModel;
  /** Data de início da época atual (para "desde o início"). */
  epochStart?: { date: string; price: number };
  seasonalIndex?: Record<number, { mean: number; n: number }>;
}

export const LEVEL_ICON: Record<Level, string> = { boa: "🟢", muito_boa: "🟢🟢", rara: "🟢🟢🟢" };

/**
 * Junta as linhas. Todo texto aqui é gerado pelo app (números e frases fixas, nada vindo de
 * fora), então pode levar tags HTML do Telegram (<b>) sem escapar.
 */
export const esc = (lines: (string | undefined)[]) =>
  lines.filter((l): l is string => l !== undefined).join("\n");

/** "−5% (R$ 5,75) · −8% (R$ 5,57)": os níveis que ainda faltam, com o preço de cada um. */
export function nextLevels(signal: Signal, level: Level, levels: Record<Level, number>): string | undefined {
  const order: Level[] = ["boa", "muito_boa", "rara"];
  const next = order.slice(order.indexOf(level) + 1);
  if (next.length === 0) return undefined;
  return next
    .map((l) => `${pct(levels[l], 0)} (R$ ${num(signal.epoch.sma250 * (1 + levels[l]))})`)
    .join(" · ");
}

/** Uma seção: título em negrito e itens com marcador, antecedida de linha em branco. Vazia some. */
export function section(title: string, items: string[]): string[] {
  return items.length === 0 ? [] : ["", `<b>${title}</b>`, ...items.map((l) => `• ${l}`)];
}

export const priceLine = (price: number) => `<b>R$ ${rate(price)}</b> por euro`;
export const vs12m = (dist: number) => `${aboveBelow(dist)} da média de 12 meses`;

/**
 * Texto do alerta em HTML do Telegram. Feito para ler de relance: título, preço em destaque,
 * uma informação por linha e blocos separados por linha em branco.
 */
export function renderAlert(ev: RuleEvent, ctx: MessageContext, levels: Record<Level, number>): string {
  const s = ctx.signal;
  const wise = wiseCostLine(ctx.feeModel, s.epoch.price);
  switch (ev.kind) {
    case "epoca_inicio": {
      const next = nextLevels(s, ev.level, levels);
      return esc([
        `${LEVEL_ICON[ev.level]} <b>Boa época pra comprar euro</b>`,
        "",
        priceLine(s.epoch.price),
        vs12m(s.epoch.dist250),
        `Mais barato que ${pct(s.epoch.pct250, 0)} dos dias do último ano`,
        "",
        `Nível: <b>${LEVEL_NAME[ev.level]}</b>`,
        next ? `Próximos: ${next}` : undefined,
        ...(wise ? ["", wise] : []),
        ...section("Para comparar", comparisonLines(s)),
        ...section("Fique de olho", contextLines(s, ctx.today)),
      ]);
    }
    case "epoca_nivel": {
      const next = nextLevels(s, ev.level, levels);
      return esc([
        `${LEVEL_ICON[ev.level]} <b>Boa época ficou melhor</b>`,
        "",
        priceLine(s.epoch.price),
        vs12m(s.epoch.dist250),
        `Nível: <b>${LEVEL_NAME[ev.level]}</b>`,
        "",
        ctx.epochStart
          ? `Desde o início (${ddmm(ctx.epochStart.date)}): ${pct(s.epoch.price / ctx.epochStart.price - 1, 1, true)}`
          : undefined,
        next ? `Próximo nível: ${next}` : "Já é o nível mais alto",
        ...(wise ? ["", wise] : []),
      ]);
    }
    case "epoca_fim": {
      const start = new Date(ev.startTs - 3 * 3600_000).toISOString().slice(0, 10);
      const minDate = new Date(ev.minTs - 3 * 3600_000).toISOString().slice(0, 10);
      return esc([
        `⚪ <b>Boa época terminou</b>`,
        "",
        priceLine(s.epoch.price),
        `Voltou para ${vs12m(s.epoch.dist250)}`,
        ...section("Como foi", [
          `Começou em ${ddmm(start)} a R$ ${rate(ev.entryPrice)}`,
          `Mais baixo: R$ ${rate(ev.minPrice)} (${pct(ev.minDist, 1, true)}) em ${ddmm(minDate)}`,
          `Chegou ao nível ${LEVEL_NAME[ev.levelReached]}`,
        ]),
      ]);
    }
    case "disparada": {
      const d = s.decomposition.find((x) => x.days === 5);
      return esc([
        `🔺 <b>Euro disparando</b>`,
        "",
        priceLine(s.epoch.price),
        `${pct(Math.exp(ev.ret5) - 1, 1, true)} em 5 dias`,
        d ? originOf(d) : undefined,
        vs12m(s.epoch.dist250),
      ]);
    }
    case "sazonal": {
      const idx = ctx.seasonalIndex?.[ev.month];
      const media = idx
        ? `Em média ${num(Math.abs(idx.mean), 1)}% ${idx.mean < 0 ? "abaixo" : "acima"} da tendência (${idx.n} anos)`
        : undefined;
      return ev.month === 12
        ? esc([
            `🗓️ <b>Dezembro começou</b>`,
            "",
            "Costuma ser o mês mais caro do ano pro euro",
            media,
            "",
            "Janeiro e fevereiro costumam aliviar.",
          ])
        : esc([
            `🗓️ <b>Junho começou</b>`,
            "",
            "Começa a época mais barata do ano pro euro (junho e julho)",
            media,
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
