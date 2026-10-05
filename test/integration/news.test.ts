import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { type Deps } from "../../src/deps";
import { fixedClock } from "../../src/lib/time";
import { sendNewsAnalysis } from "../../src/telegram/commands";

const NEWS = {
  resumo: "O euro caiu porque o resultado da eleição fortaleceu o real.",
  o_que_aconteceu: ["1º turno da eleição → entrada de capital estrangeiro, real mais forte"],
  tendencia_7d: "baixa",
  tendencia_explicacao: "O real deve seguir forte até o 2º turno.",
  o_que_pode_mudar: [],
  fontes: [{ titulo: "Euro derrete após o 1º turno", url: "https://www.estadao.com.br/x" }],
};
const NOW = Date.parse("2026-09-24T13:00:00Z");
const aiEnv = { ...env, GROQ_API_KEY: "test-groq" } as Env;

function network(groq: (model: string, body: Record<string, unknown>) => Response) {
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  const groqCalls: Record<string, unknown>[] = [];
  const fetch: Deps["fetch"] = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.startsWith("https://api.groq.com/")) {
      groqCalls.push(body);
      return groq(String(body.model), body);
    }
    telegram.push({ method: url.split("/").pop()!, body });
    return Response.json({ ok: true, result: { message_id: 900 + telegram.length } });
  };
  return { telegram, groqCalls, deps: (ms = NOW): Deps => ({ clock: fixedClock(ms), fetch }) };
}
const reply = (content: string) => Response.json({ choices: [{ message: { content } }] });

beforeAll(async () => {
  const ins = env.DB.prepare(
    "INSERT INTO daily_close (pair, date, close, source) VALUES ('EURBRL', ?, ?, 'ecb')",
  );
  const rows = golden.dates.map((d, j) => ins.bind(d, golden.prices[j]!));
  for (let i = 0; i < rows.length; i += 500) await env.DB.batch(rows.slice(i, i + 500));
  await env.DB.prepare("INSERT INTO rates (pair, ts, mid, source) VALUES ('EURBRL', ?, 5.8, 'wise-public')")
    .bind(NOW - 60_000)
    .run();
});

beforeEach(async () => {
  await env.DB.batch(["predictions", "ai_calls", "state"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("análise de notícias sob demanda", () => {
  it("avisa que está pesquisando, usa a busca do Groq e troca a mensagem pelo resultado", async () => {
    const n = network(() => reply(`Segue:\n${JSON.stringify(NEWS)}`));
    await sendNewsAnalysis(aiEnv, n.deps());
    expect(n.groqCalls[0]).toMatchObject({
      model: "openai/gpt-oss-120b",
      tools: [{ type: "browser_search" }],
    });
    expect(n.telegram.map((t) => t.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(String(n.telegram[0]!.body.text)).toContain("Pesquisando as notícias");
    expect(String(n.telegram[1]!.body.text)).toContain("<b>Por que o euro está se mexendo</b>");
    const pred = await env.DB.prepare("SELECT kind, value, price_at FROM predictions").first();
    expect(pred).toEqual({ kind: "tendencia_7d", value: -1, price_at: 5.8 });
  });

  it("reaproveita a análise por 30 minutos", async () => {
    const n = network(() => reply(JSON.stringify(NEWS)));
    await sendNewsAnalysis(aiEnv, n.deps());
    await sendNewsAnalysis(aiEnv, n.deps(NOW + 10 * 60_000));
    expect(n.groqCalls).toHaveLength(1);
    await sendNewsAnalysis(aiEnv, n.deps(NOW + 31 * 60_000));
    expect(n.groqCalls).toHaveLength(2);
  });

  it("se o 120b falhar, usa o 20b; se tudo falhar, avisa", async () => {
    const n = network((model) =>
      model.endsWith("120b") ? new Response("limite", { status: 429 }) : reply(JSON.stringify(NEWS)),
    );
    await sendNewsAnalysis(aiEnv, n.deps());
    expect(n.groqCalls.map((c) => c.model)).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
    expect(String(n.telegram[1]!.body.text)).toContain("Por que o euro está se mexendo");

    await env.DB.prepare("DELETE FROM state").run();
    const down = network(() => reply("não sei"));
    await sendNewsAnalysis(aiEnv, down.deps());
    expect(String(down.telegram[1]!.body.text)).toContain("não conseguiu pesquisar");
  });
});
