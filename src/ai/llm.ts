import { getState, setState } from "../db/state";
import { type FetchFn, HttpError, http } from "../lib/http";
import { errorFields, log } from "../lib/log";

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  task: "alerta" | "analise";
  system: string;
  user: string;
  schema: JsonSchema;
  timeoutMs?: number;
}

/** Provedor compatível com a API da OpenAI (Groq, Cerebras, OpenRouter). */
export interface LlmProvider {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Campos extras do corpo (ex.: reasoning_effort do gpt-oss). */
  extra?: Record<string, unknown>;
}

/** Depois de tantas falhas seguidas, o provedor fica fora por um tempo. */
const BREAKER_FAILS = 3;
const BREAKER_MS = 15 * 60 * 1000;

type Breakers = Record<string, { fails: number; until: number }>;

export function groqProviders(apiKey: string | undefined): LlmProvider[] {
  if (!apiKey) return [];
  const base = { baseUrl: "https://api.groq.com/openai/v1", apiKey };
  const gptOss = { reasoning_effort: "low", include_reasoning: false };
  return [
    { name: "groq", model: "openai/gpt-oss-120b", ...base, extra: gptOss },
    { name: "groq", model: "openai/gpt-oss-20b", ...base, extra: gptOss },
  ];
}

async function callOnce(
  fetchImpl: FetchFn,
  p: LlmProvider,
  req: LlmRequest,
  retryNote?: string,
): Promise<string> {
  const messages = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
    ...(retryNote ? [{ role: "user", content: retryNote }] : []),
  ];
  const res = await http(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: p.model,
      messages,
      temperature: 0.3,
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema },
      },
      ...p.extra,
    }),
    fetchImpl,
    retries: 1, // uma nova tentativa em 429/5xx
    timeoutMs: req.timeoutMs ?? 20_000,
  });
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("resposta sem conteúdo");
  return content;
}

/**
 * Pede uma resposta em JSON à cadeia de provedores, na ordem. Cada resposta passa por
 * `validate`; se falhar, o mesmo provedor tenta de novo uma vez com o erro, depois vai para o
 * próximo. Registra tudo em `ai_calls` e mantém o disjuntor de cada provedor/modelo.
 */
export async function completeJson<T>(
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
          const raw = await callOnce(fetchImpl, p, req, note);
          const value = validate(JSON.parse(raw));
          await record(p, true, started);
          return { value, provider: p.name, model: p.model };
        } catch (err) {
          const msg = err instanceof HttpError ? `${err.message}: ${err.body.slice(0, 200)}` : String(err);
          await record(p, false, started, msg);
          log("warn", "ia: tentativa falhou", {
            provider: p.name,
            model: p.model,
            attempt,
            ...errorFields(err),
          });
          if (err instanceof HttpError && err.status !== 400) break; // erro de rede/limite: vai para o próximo
          note = `Sua resposta anterior foi recusada: ${msg.slice(0, 300)}. Responda de novo, só com o JSON válido.`;
        }
      }
    }
    return undefined;
  } finally {
    await setState(db, "ai_breakers", breakers, now);
  }
}
