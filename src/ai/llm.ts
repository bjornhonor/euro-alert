import { getState, setState } from "../db/state";
import { type FetchFn, HttpError, http } from "../lib/http";
import { errorFields, log } from "../lib/log";

export interface LlmRequest {
  task: "analise";
  system: string;
  user: string;
  timeoutMs?: number;
}

/** Modelo no Groq (API compatível com a da OpenAI). */
export interface LlmProvider {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** Depois de tantas falhas seguidas, o modelo fica fora por um tempo. */
const BREAKER_FAILS = 3;
const BREAKER_MS = 15 * 60 * 1000;

type Breakers = Record<string, { fails: number; until: number }>;

/** Só o Groq: o gpt-oss tem busca na web embutida (`browser_search`). O 20b é a reserva. */
export function groqProviders(apiKey: string | undefined): LlmProvider[] {
  if (!apiKey) return [];
  const base = { name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey };
  return [
    { ...base, model: "openai/gpt-oss-120b" },
    { ...base, model: "openai/gpt-oss-20b" },
  ];
}

async function callWithSearch(
  fetchImpl: FetchFn,
  p: LlmProvider,
  req: LlmRequest,
  note?: string,
): Promise<string> {
  const res = await http(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: p.model,
      temperature: 0.3,
      reasoning_effort: "medium",
      tools: [{ type: "browser_search" }],
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
        ...(note ? [{ role: "user", content: note }] : []),
      ],
    }),
    fetchImpl,
    retries: 1, // uma nova tentativa em 429/5xx
    timeoutMs: req.timeoutMs ?? 60_000,
  });
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("resposta sem conteúdo");
  return content;
}

/** Tira o JSON do texto (às vezes vem entre ``` ou com uma frase antes). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("a resposta não tem JSON");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Pede uma resposta com busca na web, na ordem dos modelos. A resposta passa por `validate`;
 * se falhar, o mesmo modelo tenta de novo uma vez com o erro, depois vai para o próximo.
 * Registra tudo em `ai_calls` e mantém o disjuntor de cada modelo.
 */
export async function completeWithSearch<T>(
  db: D1Database,
  fetchImpl: FetchFn,
  providers: readonly LlmProvider[],
  req: LlmRequest,
  validate: (raw: unknown) => T,
  now: number,
): Promise<{ value: T; provider: string; model: string } | undefined> {
  const breakers = (await getState<Breakers>(db, "ai_breakers")) ?? {};
  const record = async (p: LlmProvider, ok: boolean, started: number, error?: string) => {
    await db
      .prepare(
        "INSERT INTO ai_calls (ts, task, provider, model, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(now, req.task, p.name, p.model, ok ? 1 : 0, Date.now() - started, error?.slice(0, 300) ?? null)
      .run();
    const key = `${p.name}:${p.model}`;
    const b = breakers[key] ?? { fails: 0, until: 0 };
    breakers[key] = ok
      ? { fails: 0, until: 0 }
      : { fails: b.fails + 1, until: b.fails + 1 >= BREAKER_FAILS ? now + BREAKER_MS : b.until };
  };

  try {
    for (const p of providers) {
      if ((breakers[`${p.name}:${p.model}`]?.until ?? 0) > now) continue;
      let note: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        try {
          const value = validate(extractJson(await callWithSearch(fetchImpl, p, req, note)));
          await record(p, true, started);
          return { value, provider: p.name, model: p.model };
        } catch (err) {
          const msg = err instanceof HttpError ? `${err.message}: ${err.body.slice(0, 200)}` : String(err);
          await record(p, false, started, msg);
          log("warn", "ia: tentativa falhou", { model: p.model, attempt, ...errorFields(err) });
          if (err instanceof HttpError && err.status !== 400) break; // limite ou rede: próximo modelo
          note = `Sua resposta anterior foi recusada: ${msg.slice(0, 300)}. Responda de novo, só com o JSON pedido.`;
        }
      }
    }
    return undefined;
  } finally {
    await setState(db, "ai_breakers", breakers, now);
  }
}
