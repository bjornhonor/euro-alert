import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { latestSignal } from "../jobs/signals";
import { brt } from "../lib/time";
import { completeWithSearch, groqProviders } from "./llm";
import {
  buildNewsContext,
  NEWS_SYSTEM_PROMPT,
  type NewsAnalysis,
  TREND_VALUE,
  validateNews,
} from "./news-analyst";

/** Cada análise faz várias buscas (~20 mil tokens): reaproveita a última por 30 minutos. */
const CACHE_MS = 30 * 60 * 1000;

interface Cached {
  ts: number;
  analysis: NewsAnalysis;
}

/**
 * Análise de notícias e cenário (a única IA do app). Só roda quando pedida: botão 🤖 ou
 * /analise. Usa a última por até 30 min; guarda no alerta (se veio de um) e registra a
 * tendência de 7 dias em `predictions` para o placar.
 */
export async function newsAnalysis(
  env: Env,
  deps: Deps,
  opts: { alertId?: number } = {},
): Promise<{ analysis: NewsAnalysis; ts: number } | undefined> {
  const now = deps.clock.now();
  const cached = await getState<Cached>(env.DB, "news_analysis");
  let result: Cached | undefined = cached && now - cached.ts < CACHE_MS ? cached : undefined;

  if (!result) {
    const providers = groqProviders(env.GROQ_API_KEY);
    if (providers.length === 0) return undefined;
    const { signal } = await latestSignal(env, now);
    if (!signal) return undefined;
    const t = brt(now);
    const res = await completeWithSearch(
      env.DB,
      deps.fetch,
      providers,
      { task: "analise", system: NEWS_SYSTEM_PROMPT, user: buildNewsContext(signal, t.date, t.hour) },
      validateNews,
      now,
    );
    if (!res) return undefined;
    result = { ts: now, analysis: res.value };
    await setState(env.DB, "news_analysis", result, now);
    await env.DB.prepare(
      "INSERT INTO predictions (ts, kind, value, price_at) VALUES (?, 'tendencia_7d', ?, ?)",
    )
      .bind(now, TREND_VALUE[res.value.tendencia_7d], signal.epoch.price)
      .run();
  }

  if (opts.alertId) {
    await env.DB.prepare("UPDATE alerts SET ai_comment = ? WHERE id = ?")
      .bind(JSON.stringify(result), opts.alertId)
      .run();
  }
  return { analysis: result.analysis, ts: result.ts };
}

/** Preenche o preço 7 dias, 1 e 3 meses depois de cada previsão da IA (manutenção diária). */
export async function updatePredictions(db: D1Database, now: number): Promise<void> {
  const fill = (col: "price_7d" | "price_1m" | "price_3m", days: number) =>
    db
      .prepare(
        `UPDATE predictions SET ${col} = (SELECT close FROM daily_close WHERE pair = 'EURBRL' ` +
          `AND date >= date(predictions.ts / 1000 - 10800 + ?1 * 86400, 'unixepoch') ORDER BY date LIMIT 1) ` +
          `WHERE ${col} IS NULL AND ts <= ?2`,
      )
      .bind(days, now - days * 86_400_000)
      .run();
  await fill("price_7d", 7);
  await fill("price_1m", 30);
  await fill("price_3m", 91);
}
