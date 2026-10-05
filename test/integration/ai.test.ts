import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { processAlerts } from "../../src/alerts/run";
import { type Deps } from "../../src/deps";
import { computeSignal } from "../../src/engine/signal";
import { fixedClock } from "../../src/lib/time";
import { alertAnalysis } from "../../src/telegram/commands";

const signal = computeSignal({
  closes: golden.prices.slice(0, -1),
  live: golden.prices.at(-1)!,
  real: { mean: 5.4013, dist: 0.0843, cheaperThan: 0.3, days: 6331 },
})!;
const answer = {
  leitura: "tendencia_de_queda",
  confianca: "media",
  motivos: ["A média de 12 meses está caindo"],
  riscos: [],
  o_que_mudaria: "A média de 12 meses voltar a subir",
  texto_curto:
    "O euro está 3,3% abaixo da média de 12 meses, mas a média vem caindo: parece tendência de queda.",
};
const WED_10H = Date.parse("2026-10-14T13:00:00Z");
const aiEnv = { ...env, GROQ_API_KEY: "test-groq" } as Env;

/** Telegram e Groq simulados. `groq` decide a resposta de cada modelo. */
function network(groq: (model: string) => Response) {
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  const models: string[] = [];
  const fetch: Deps["fetch"] = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.startsWith("https://api.groq.com/")) {
      models.push(body.model);
      return groq(body.model);
    }
    telegram.push({ method: url.split("/").pop()!, body });
    return Response.json({ ok: true, result: { message_id: 500 + telegram.length } });
  };
  return { telegram, models, deps: (ms: number): Deps => ({ clock: fixedClock(ms), fetch }) };
}
const chat = (content: unknown) =>
  Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });

beforeEach(async () => {
  await env.DB.batch(
    ["alert_outcomes", "predictions", "ai_calls", "alerts", "epochs", "state", "config"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

async function twoReadings(n: ReturnType<typeof network>) {
  await processAlerts(aiEnv, n.deps(WED_10H), WED_10H, signal);
  await processAlerts(aiEnv, n.deps(WED_10H + 15 * 60_000), WED_10H + 15 * 60_000, signal);
}

describe("IA do alerta", () => {
  it("o alerta sai na hora e o comentário entra editando a mensagem", async () => {
    const n = network(() => chat(answer));
    await twoReadings(n);
    expect(n.telegram.map((t) => t.method)).toEqual(["sendMessage", "editMessageText"]);
    const edited = String(n.telegram[1]!.body.text);
    expect(edited).toContain("<b>Boa época pra comprar euro</b>");
    expect(edited).toContain("🤖 <b>Leitura da IA:</b> tendência de queda (confiança média)");
    expect(n.telegram[1]!.body.reply_markup).toBeDefined();

    const alert = await env.DB.prepare("SELECT id, ai_comment FROM alerts").first<{
      id: number;
      ai_comment: string;
    }>();
    expect(JSON.parse(alert!.ai_comment)).toMatchObject({
      leitura: "tendencia_de_queda",
      model: "openai/gpt-oss-120b",
    });
    const pred = await env.DB.prepare("SELECT kind, value, price_at, ref_id FROM predictions").first();
    expect(pred).toEqual({ kind: "leitura_alerta", value: -1, price_at: 5.8564, ref_id: alert!.id });
  });

  it("se o 120b falhar, usa o 20b", async () => {
    const n = network((model) =>
      model.endsWith("120b")
        ? new Response('{"error":{"message":"json_validate_failed"}}', { status: 400 })
        : chat(answer),
    );
    await twoReadings(n);
    expect(n.models).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(n.telegram.map((t) => t.method)).toEqual(["sendMessage", "editMessageText"]);
    const calls = await env.DB.prepare("SELECT model, ok FROM ai_calls ORDER BY id").all();
    expect(calls.results).toEqual([
      { model: "openai/gpt-oss-120b", ok: 0 },
      { model: "openai/gpt-oss-120b", ok: 0 },
      { model: "openai/gpt-oss-20b", ok: 1 },
    ]);
  });

  it("resposta com número inventado: o alerta fica sem comentário", async () => {
    const n = network(() =>
      chat({ ...answer, texto_curto: "O euro deve chegar a 4,95 em dezembro, pela tendência de queda." }),
    );
    await twoReadings(n);
    expect(n.telegram.map((t) => t.method)).toEqual(["sendMessage"]);
  });

  it("botão 🤖 mostra a análise completa guardada", async () => {
    const n = network(() => chat(answer));
    await twoReadings(n);
    const alert = await env.DB.prepare("SELECT id FROM alerts").first<{ id: number }>();
    const text = await alertAnalysis(aiEnv, n.deps(WED_10H), alert!.id);
    expect(text).toContain("🤖 <b>Análise da IA</b>");
    expect(text).toContain("<b>Por quê</b>\n• A média de 12 meses está caindo");
    expect(text).toContain("<b>O que mudaria a leitura</b>");
  });
});
