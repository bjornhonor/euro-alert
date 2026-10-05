import { type Deps } from "../deps";
import { type Signal } from "../engine/signal";
import { brt } from "../lib/time";
import { loadScore } from "../alerts/scorecard";
import {
  type Analysis,
  ANALYSIS_JSON_SCHEMA,
  buildAnalystInput,
  READING_VALUE,
  SYSTEM_PROMPT,
  validateAnalysis,
} from "./alert-analyst";
import { completeJson, groqProviders } from "./llm";

const FIVE_YEARS_MS = 5 * 365.25 * 86_400_000;

/**
 * Pede a leitura da IA para um alerta (ou para o momento, no /analise), valida, guarda em
 * `alerts.ai_comment` e registra a previsão em `predictions` para o placar da IA.
 * Devolve undefined se a IA não estiver configurada ou se nenhuma resposta passar na validação.
 */
export async function analyze(
  env: Env,
  deps: Deps,
  opts: { kind: string; level: string | null; signal: Signal; alertId?: number; task?: "alerta" | "analise" },
): Promise<Analysis | undefined> {
  const providers = groqProviders(env.GROQ_API_KEY);
  if (providers.length === 0) return undefined;
  const now = deps.clock.now();
  const input = buildAnalystInput({
    kind: opts.kind,
    level: opts.level,
    signal: opts.signal,
    today: brt(now).date,
    score: await loadScore(env.DB, now - FIVE_YEARS_MS),
  });
  const res = await completeJson(
    env.DB,
    deps.fetch,
    providers,
    {
      task: opts.task ?? "alerta",
      system: SYSTEM_PROMPT,
      user: `Entrada:\n${JSON.stringify(input)}`,
      schema: ANALYSIS_JSON_SCHEMA,
    },
    (raw) => validateAnalysis(raw, input),
    now,
  );
  if (!res) return undefined;

  const a = res.value;
  if (opts.alertId) {
    await env.DB.prepare("UPDATE alerts SET ai_comment = ? WHERE id = ?")
      .bind(JSON.stringify({ ...a, provider: res.provider, model: res.model }), opts.alertId)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO predictions (ts, kind, value, price_at, ref_id) VALUES (?, 'leitura_alerta', ?, ?, ?)",
  )
    .bind(now, READING_VALUE[a.leitura], opts.signal.epoch.price, opts.alertId ?? null)
    .run();
  return a;
}

/** Preenche o preço 1 e 3 meses depois de cada leitura da IA (manutenção diária). */
export async function updatePredictions(db: D1Database, now: number): Promise<void> {
  const fill = (col: "price_1m" | "price_3m", days: number) =>
    db
      .prepare(
        `UPDATE predictions SET ${col} = (SELECT close FROM daily_close WHERE pair = 'EURBRL' ` +
          `AND date >= date(predictions.ts / 1000 - 10800 + ?1 * 86400, 'unixepoch') ORDER BY date LIMIT 1) ` +
          `WHERE ${col} IS NULL AND ts <= ?2`,
      )
      .bind(days, now - days * 86_400_000)
      .run();
  await fill("price_1m", 30);
  await fill("price_3m", 91);
}
