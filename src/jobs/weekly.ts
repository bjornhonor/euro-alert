import { type EpochState } from "../alerts/rules";
import { loadScore } from "../alerts/scorecard";
import { getState } from "../db/state";
import { type Deps } from "../deps";
import { brt } from "../lib/time";
import { TelegramApi } from "../telegram/api";
import { renderWeekly } from "../telegram/views";
import { latestSignal } from "./signals";

const DAY_MS = 86_400_000;
/** Coletas esperadas numa semana: a cada 15 min, segunda a sexta (UTC). */
const EXPECTED_TICKS = 96 * 5;

/** Semana ISO da data 'YYYY-MM-DD'. */
export function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
}

/** Relatório de sexta 18h: a semana do euro, o placar do último ano e a saúde do sistema. */
export async function weekly(env: Env, deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const today = brt(now).date;
  const { signal } = await latestSignal(env, now);
  if (!signal) return;
  // fechamento de 5 dias úteis atrás (a sexta anterior, numa semana normal)
  const weekAgo = await env.DB.prepare(
    "SELECT close FROM daily_close WHERE pair = 'EURBRL' AND date < ? ORDER BY date DESC LIMIT 1 OFFSET 4",
  )
    .bind(today)
    .first<{ close: number }>();
  const ticks = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(source LIKE 'wise%') AS wise FROM rates WHERE pair = 'EURBRL' AND ts >= ?",
  )
    .bind(now - 7 * DAY_MS)
    .first<{ n: number; wise: number | null }>();
  const alerts = await env.DB.prepare(
    "SELECT SUM(delivered = 1) AS sent, SUM(delivered = 0 AND json_extract(context, '$.backfill') IS NULL) AS held " +
      "FROM alerts WHERE kind != 'sistema' AND ts >= ?",
  )
    .bind(now - 7 * DAY_MS)
    .first<{ sent: number | null; held: number | null }>();
  const state = await getState<EpochState>(env.DB, "epoch_state");
  const maint = await getState<{ failed: string[] }>(env.DB, "last_maintenance");

  const text = renderWeekly({
    week: isoWeek(today),
    price: signal.epoch.price,
    weekChange: weekAgo ? signal.epoch.price / weekAgo.close - 1 : undefined,
    dist250: signal.epoch.dist250,
    epoch:
      state?.active && state.startTs
        ? { start: brt(state.startTs).date, level: state.levelAlerted ?? "boa" }
        : undefined,
    year: await loadScore(env.DB, now - 365 * DAY_MS),
    ticks: {
      done: ticks?.n ?? 0,
      expected: EXPECTED_TICKS,
      wisePct: ticks?.n ? (ticks.wise ?? 0) / ticks.n : 0,
    },
    alerts: { sent: alerts?.sent ?? 0, held: alerts?.held ?? 0 },
    maintenanceFailed: maint?.failed ?? [],
  });
  await new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch).sendMessage(env.TELEGRAM_CHAT_ID, text, {
    silent: true,
  });
}
