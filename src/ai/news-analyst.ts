import { z } from "zod";
import { upcomingEvents } from "../alerts/context";
import { ddmm, num, pct } from "../alerts/format";
import { type Signal } from "../engine/signal";
import { escapeHtml } from "../telegram/api";

/** Tendência do euro contra o real nos próximos 7 dias (alta = euro mais caro em reais). */
export type Trend = "alta" | "baixa" | "lateral" | "incerta";

export const NewsAnalysisSchema = z.object({
  resumo: z.string().min(20).max(400),
  o_que_aconteceu: z.array(z.string().min(10)).min(1).max(4),
  tendencia_7d: z.enum(["alta", "baixa", "lateral", "incerta"]),
  tendencia_explicacao: z.string().min(10).max(500),
  o_que_pode_mudar: z.array(z.string().min(5)).max(3),
  fontes: z
    .array(z.object({ titulo: z.string().min(3), url: z.string().regex(/^https?:\/\//) }))
    .min(1)
    .max(6),
});

export type NewsAnalysis = z.infer<typeof NewsAnalysisSchema>;

export const NEWS_SYSTEM_PROMPT = `Você é um analista de câmbio. Explica para uma pessoa que compra euros aos poucos, pela Wise, por que o euro está se mexendo contra o real e o que pode vir nos próximos 7 dias.

Use a busca na web (browser_search) para achar as notícias mais importantes dos últimos 7 dias que afetam o EUR/BRL. Procure dos dois lados:
- Euro: BCE e juros na zona do euro, inflação e crescimento europeus, política na Europa (ex.: França, Alemanha), EUR/USD.
- Real: política e eleições no Brasil, situação fiscal, Copom e Selic, fluxo estrangeiro, commodities, USD/BRL.
- Global: Fed e dólar, apetite a risco, petróleo, geopolítica.
Faça mais de uma busca se precisar e prefira fontes de notícia confiáveis (Reuters, Bloomberg, Valor, InfoMoney, CNN, G1, Financial Times, Estadão).

Como responder:
1. Explique a cadeia de causa e efeito: qual notícia moveu o quê e por que isso mexeu no euro contra o real. Diga qual lado puxou mais (o euro lá fora ou o real).
2. Não analise indicador por indicador nem repita números do gráfico; a pessoa já vê os números. Cite números só quando forem parte da notícia (ex.: "a Selic foi a 13,75%").
3. Tendência para os próximos 7 dias: "alta" (euro mais caro em reais), "baixa" (euro mais barato), "lateral" ou "incerta". Baseie nos eventos e notícias dos próximos dias, não em promessa.
4. Português do Brasil, frases curtas, sem jargão. Nunca diga para comprar ou vender.
5. Inclua as fontes que você usou, com título e link.

Responda só com um JSON neste formato, sem texto antes ou depois:
{
  "resumo": "a explicação em 1 ou 2 frases",
  "o_que_aconteceu": ["de 1 a 4 itens: notícia → efeito no euro ou no real"],
  "tendencia_7d": "alta" | "baixa" | "lateral" | "incerta",
  "tendencia_explicacao": "por que, em 1 ou 2 frases",
  "o_que_pode_mudar": ["de 0 a 3 eventos ou riscos que mudariam o cenário"],
  "fontes": [{ "titulo": "...", "url": "https://..." }]
}`;

/** O que a IA recebe do app: só o movimento do preço e o calendário, para guiar a busca. */
export function buildNewsContext(signal: Signal, today: string, hour: number): string {
  const r = signal.recent;
  const last = r.at(-1)!;
  const change = (days: number) => (r.length > days ? last / r[r.length - 1 - days]! - 1 : undefined);
  const d5 = signal.decomposition.find((d) => d.days === 5);
  const lines = [
    `Hoje: ${today}, ${hour}h no horário de Brasília.`,
    `EUR/BRL agora: R$ ${num(last, 4)}.`,
    ...([1, 5, 20] as const).flatMap((d) => {
      const c = change(d);
      return c === undefined
        ? []
        : [`Variação em ${d} ${d === 1 ? "dia útil" : "dias úteis"}: ${pct(c, 1, true)}.`];
    }),
    ...(d5
      ? [`Nos últimos 5 dias: EUR/USD ${pct(d5.eurusd, 1, true)} e USD/BRL ${pct(d5.usdbrl, 1, true)}.`]
      : []),
    `O euro está ${pct(Math.abs(signal.epoch.dist250))} ${signal.epoch.dist250 < 0 ? "abaixo" : "acima"} da média dos últimos 12 meses.`,
    ...upcomingEvents(today, 7).map((e) => `Evento no calendário: ${e.title} em ${ddmm(e.date)}.`),
  ];
  return lines.join("\n");
}

/** Tira as marcas de citação do gpt-oss (ex.: 【1†L18-L27】). */
const clean = (s: string) =>
  s
    .replace(/【[^】]*】/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

export function validateNews(raw: unknown): NewsAnalysis {
  const a = NewsAnalysisSchema.parse(raw);
  return {
    ...a,
    resumo: clean(a.resumo),
    o_que_aconteceu: a.o_que_aconteceu.map(clean),
    tendencia_explicacao: clean(a.tendencia_explicacao),
    o_que_pode_mudar: a.o_que_pode_mudar.map(clean),
    fontes: a.fontes.map((f) => ({ titulo: clean(f.titulo), url: f.url })),
  };
}

const TREND_TEXT: Record<Trend, string> = {
  alta: "📈 euro tende a <b>subir</b> frente ao real",
  baixa: "📉 euro tende a <b>cair</b> frente ao real",
  lateral: "➡️ euro tende a ficar <b>de lado</b>",
  incerta: "❔ tendência <b>incerta</b>",
};

/** Mensagem do Telegram. Todo texto da IA é escapado (vem de fora). */
export function renderNews(a: NewsAnalysis, when: { date: string; hour: number; minute: number }): string {
  const e = escapeHtml;
  const attr = (url: string) => url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return [
    `🌍 <b>Por que o euro está se mexendo</b> · ${ddmm(when.date)} ${String(when.hour).padStart(2, "0")}h${String(when.minute).padStart(2, "0")}`,
    "",
    `<i>${e(a.resumo)}</i>`,
    "",
    "<b>O que aconteceu</b>",
    ...a.o_que_aconteceu.map((x) => `• ${e(x)}`),
    "",
    `<b>Próximos 7 dias:</b> ${TREND_TEXT[a.tendencia_7d]}`,
    e(a.tendencia_explicacao),
    ...(a.o_que_pode_mudar.length
      ? ["", "<b>O que pode mudar</b>", ...a.o_que_pode_mudar.map((x) => `• ${e(x)}`)]
      : []),
    "",
    "<b>Fontes</b>",
    ...a.fontes.map((f) => `• <a href="${attr(f.url)}">${e(f.titulo)}</a>`),
    "",
    "<i>Análise automática com notícias da web. Não é recomendação.</i>",
  ].join("\n");
}

/** Para o placar da IA: +1 = euro deve subir, −1 = cair, 0 = de lado ou incerto. */
export const TREND_VALUE: Record<Trend, number> = { alta: 1, baixa: -1, lateral: 0, incerta: 0 };
