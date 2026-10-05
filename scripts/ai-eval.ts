/**
 * Avaliação da IA do alerta (Etapa 7.7): 20 inícios de época reais desde 2002, cada um mandado
 * para a mesma cadeia do app (Groq 120b → 20b). Confere schema, idioma, tamanho e se todo número
 * citado existe na entrada, e compara a leitura com o que o euro fez nos 3 meses seguintes.
 *
 *   npm run ai-eval
 *
 * Usa GROQ_API_KEY do .dev.vars. Faz ~20 chamadas (cota grátis: 1.000 por dia).
 */
import golden from "../test/fixtures/golden.json" with { type: "json" };
import {
  ANALYSIS_JSON_SCHEMA,
  buildAnalystInput,
  SYSTEM_PROMPT,
  validateAnalysis,
  type Analysis,
} from "../src/ai/alert-analyst";
import { groqProviders } from "../src/ai/llm";
import { historicalEpochs } from "../src/alerts/history";
import { kByMonth, realContext } from "../src/engine/real-rate";
import { computeSignal } from "../src/engine/signal";

const key = process.env.GROQ_API_KEY;
if (!key) {
  console.error("Preencha GROQ_API_KEY no .dev.vars.");
  process.exit(1);
}

const { dates, prices, ipca, hicp } = golden;
const k = kByMonth(ipca, hicp, dates.at(-1)!.slice(0, 7));
const epochs = historicalEpochs(dates, prices).filter((e) => dates.indexOf(e.start) >= 400);
const step = Math.max(1, Math.floor(epochs.length / 20));
const picks = epochs.filter((_, i) => i % step === 0).slice(0, 20);

async function ask(input: unknown): Promise<{ a?: Analysis; error?: string; model?: string; ms: number }> {
  const started = Date.now();
  let lastError = "";
  for (const p of groqProviders(key)) {
    let note: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: p.model,
          temperature: 0.3,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Entrada:\n${JSON.stringify(input)}` },
            ...(note ? [{ role: "user", content: note }] : []),
          ],
          response_format: { type: "json_schema", json_schema: { ...ANALYSIS_JSON_SCHEMA, strict: true } },
          ...p.extra,
        }),
      });
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message: string };
      };
      try {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error?.message}`);
        const a = validateAnalysis(JSON.parse(body.choices?.[0]?.message?.content ?? ""), input);
        return { a, model: p.model, ms: Date.now() - started };
      } catch (err) {
        lastError = String(err).slice(0, 160);
        if (res.status === 429) await new Promise((r) => setTimeout(r, 5000));
        note = `Sua resposta anterior foi recusada: ${lastError}. Responda de novo, só com o JSON válido.`;
      }
    }
  }
  return { error: lastError, ms: Date.now() - started };
}

const PT = /\b(o|a|de|que|não|euro|média|queda|preço)\b/i;
let ok = 0;
let agree = 0;
let judged = 0;
for (const e of picks) {
  const i = dates.indexOf(e.start);
  const closes = prices.slice(0, i);
  const signal = computeSignal({
    closes,
    live: prices[i]!,
    real: realContext(
      closes.map((p, j) => p / k.get(dates[j]!.slice(0, 7))!),
      prices[i]!,
      k.get(e.start.slice(0, 7))!,
    ),
  })!;
  const input = buildAnalystInput({ kind: "epoca_inicio", level: e.entryLevel, signal, today: e.start });
  const r = await ask(input);
  // o que aconteceu: preço 63 dias úteis depois vs início
  const after = prices[i + 63];
  const outcome = after === undefined ? "?" : after < prices[i]! ? "caiu" : "subiu";
  if (r.a && PT.test(r.a.texto_curto) && r.a.texto_curto.length <= 280) ok++;
  if (r.a && r.a.leitura !== "incerto" && outcome !== "?") {
    judged++;
    if ((r.a.leitura === "tendencia_de_queda") === (outcome === "caiu")) agree++;
  }
  console.log(
    `${e.start} ${(e.entryDist * 100).toFixed(1)}% → ${r.a ? `${r.a.leitura} (${r.a.confianca})` : `FALHOU: ${r.error}`}` +
      ` · depois de 3 meses ${outcome} · ${r.ms} ms${r.model ? ` · ${r.model.split("/")[1]}` : ""}`,
  );
  if (r.a) console.log(`   "${r.a.texto_curto}"`);
  await new Promise((r2) => setTimeout(r2, 2500)); // respeita 30 por minuto
}
console.log(
  `\nPassaram (schema + números + idioma + tamanho): ${ok}/${picks.length}` +
    ` · leitura bateu com os 3 meses seguintes: ${agree}/${judged} (sem contar "incerto")`,
);
