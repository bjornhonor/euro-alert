import { z } from "zod";
import { upcomingEvents } from "../alerts/context";
import { MONTH_NAME } from "../alerts/format";
import { type ScoreSummary } from "../alerts/outcomes";
import { type Signal } from "../engine/signal";
import { escapeHtml } from "../telegram/api";
import { type JsonSchema } from "./llm";
import { unknownNumbers } from "./numbers";

export type Reading = "desconto_temporario" | "tendencia_de_queda" | "incerto";

export const AnalysisSchema = z.object({
  leitura: z.enum(["desconto_temporario", "tendencia_de_queda", "incerto"]),
  confianca: z.enum(["baixa", "media", "alta"]),
  motivos: z.array(z.string().min(3)).min(1).max(3),
  riscos: z.array(z.string().min(3)).max(2),
  o_que_mudaria: z.string().min(3),
  texto_curto: z.string().min(20).max(280),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

/** O mesmo formato para o `response_format` (modo estrito: tudo obrigatório, nada além). */
export const ANALYSIS_JSON_SCHEMA: JsonSchema = {
  name: "leitura_alerta",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["leitura", "confianca", "motivos", "riscos", "o_que_mudaria", "texto_curto"],
    properties: {
      leitura: { type: "string", enum: ["desconto_temporario", "tendencia_de_queda", "incerto"] },
      confianca: { type: "string", enum: ["baixa", "media", "alta"] },
      motivos: { type: "array", items: { type: "string" } },
      riscos: { type: "array", items: { type: "string" } },
      o_que_mudaria: { type: "string" },
      texto_curto: { type: "string" },
    },
  },
};

export const SYSTEM_PROMPT = `Você comenta alertas sobre o câmbio EUR/BRL para uma pessoa que compra euros aos poucos, pela Wise.
Responda só com o JSON pedido.

A pergunta central: o euro está barato por um desconto temporário (tende a voltar para perto da média) ou por uma tendência de queda (pode continuar caindo)? Se os sinais se contradizem, use "incerto".

Como ler a entrada:
- "preco" é quantos reais custa 1 euro.
- Distâncias, inclinações e variações são frações: -0.076 quer dizer 7,6% abaixo.
- "mais_barato_que" é a fração dos dias do período em que o euro esteve mais caro que hoje.
- "historia_real" compara com a média desde 2002 já descontada a inflação dos dois países.

Regras:
1. Português do Brasil, frases curtas e diretas, sem jargão.
2. Use apenas números que estão na entrada (pode escrever frações como porcentagem). Não invente nem calcule números novos.
3. Nunca diga para comprar ou vender e não prometa resultado.
4. Se houver eventos nos próximos 14 dias, cite o mais importante.
5. texto_curto: até 280 caracteres, a conclusão em uma ou duas frases.
6. motivos: de 1 a 3 itens. riscos: de 0 a 2 itens. o_que_mudaria: o que faria você mudar a leitura.`;

const r = (x: number, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

export interface AnalystInput {
  kind: string;
  level: string | null;
  signal: Signal;
  today: string;
  score?: ScoreSummary;
}

/** Entrada da IA: só números já calculados (seção 9.2 do plano). Nada pessoal. */
export function buildAnalystInput({ kind, level, signal: s, today, score }: AnalystInput) {
  const e = s.epoch;
  const d20 = s.decomposition.find((d) => d.days === 20) ?? s.decomposition.at(-1);
  const month = s.seasonal;
  return {
    alerta: { tipo: kind, nivel: level, preco: r(e.price) },
    horizontes: {
      "12m": { media: r(e.sma250), distancia: r(e.dist250), mais_barato_que: r(e.pct250, 3) },
      "5a": { media: r(e.sma1260), distancia: r(e.dist1260), mais_barato_que: r(e.pct1260, 3) },
      ...(s.real
        ? {
            historia_real: {
              media: r(s.real.mean),
              distancia: r(s.real.dist),
              mais_barato_que: r(s.real.cheaperThan, 3),
            },
          }
        : {}),
    },
    tendencia: {
      inclinacao_media12m_3m: r(e.slope250),
      acima_media20: e.aboveSma20,
      acima_media50: e.aboveSma50,
    },
    curto_prazo: {
      score_0_100: r(s.score.score, 0),
      rsi14: r(s.score.rsi, 1),
      variacao_5d: r(s.score.ret5),
    },
    serie_60d: s.recent.map((p) => r(p)),
    ...(d20 ? { decomposicao: { dias: d20.days, eurusd: r(d20.eurusd), usdbrl: r(d20.usdbrl) } } : {}),
    projecao_68: s.projection.map((b) => ({ dias_uteis: b.days, de: r(b.low68), ate: r(b.high68) })),
    ...(month
      ? { sazonalidade_mes: { mes: MONTH_NAME[month.month], desvio_medio_pct: r(month.mean, 2) } }
      : {}),
    eventos_14d: upcomingEvents(today).map((ev) => ({ data: ev.date, titulo: ev.title, em_dias: ev.days })),
    ...(score && score.measured > 0
      ? {
          placar_5a: {
            epocas: score.epochs,
            inicio_vs_media_3m_seguintes: r(score.vsNext3m),
            inicio_abaixo_da_media_3m: r(score.hitRate, 2),
            queda_media_depois: r(score.furtherDrop),
          },
        }
      : {}),
  };
}

/** Valida o formato e confere que todo número citado existe na entrada. */
export function validateAnalysis(raw: unknown, input: unknown): Analysis {
  const a = AnalysisSchema.parse(raw);
  const strange = unknownNumbers([a.texto_curto, ...a.motivos, ...a.riscos, a.o_que_mudaria], input);
  if (strange.length > 0) throw new Error(`números que não estão na entrada: ${strange.join(", ")}`);
  return a;
}

const READING_NAME: Record<Reading, string> = {
  desconto_temporario: "desconto temporário",
  tendencia_de_queda: "tendência de queda",
  incerto: "incerto",
};
const CONFIDENCE_NAME = { baixa: "baixa", media: "média", alta: "alta" } as const;

/** Bloco curto que entra no fim do alerta. O texto da IA é escapado (vem de fora). */
export function commentBlock(a: Analysis): string {
  return (
    `\n\n🤖 <b>Leitura da IA:</b> ${READING_NAME[a.leitura]} (confiança ${CONFIDENCE_NAME[a.confianca]})\n` +
    `<i>${escapeHtml(a.texto_curto)}</i>`
  );
}

/** Análise completa (botão 🤖 e /analise). */
export function fullAnalysis(a: Analysis, title = "Análise da IA"): string {
  const list = (items: string[]) => items.map((x) => `• ${escapeHtml(x)}`).join("\n");
  return [
    `🤖 <b>${title}</b>`,
    "",
    `Leitura: <b>${READING_NAME[a.leitura]}</b> (confiança ${CONFIDENCE_NAME[a.confianca]})`,
    `<i>${escapeHtml(a.texto_curto)}</i>`,
    "",
    "<b>Por quê</b>",
    list(a.motivos),
    ...(a.riscos.length ? ["", "<b>Riscos</b>", list(a.riscos)] : []),
    "",
    "<b>O que mudaria a leitura</b>",
    escapeHtml(a.o_que_mudaria),
    "",
    "<i>Comentário automático sobre os números do app. Não é recomendação.</i>",
  ].join("\n");
}

/** Para o placar da IA: −1 = tendência de queda, 0 = incerto, +1 = desconto temporário. */
export const READING_VALUE: Record<Reading, number> = {
  tendencia_de_queda: -1,
  incerto: 0,
  desconto_temporario: 1,
};
