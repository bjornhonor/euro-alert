import { LEVEL_NAME, ddmm, pct, rate, WEEKDAY_SHORT } from "../alerts/format";
import { type EpochState } from "../alerts/rules";
import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { brt } from "../lib/time";
import { TelegramApi } from "../telegram/api";

interface SignalRow {
  ts: number;
  price: number;
  dist250: number;
  dist1260: number;
  real_dist: number;
  score: number;
  level: string | null;
}

/**
 * Resumo das 8h (dias úteis): preço, situação da boa época, os três horizontes e os alertas
 * que ficaram retidos desde o último resumo. Também serve de sinal de vida diário.
 * A parte de IA macro entra na Etapa 8.
 */
export async function summary(env: Env, deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const today = brt(now);
  const sig = await env.DB.prepare(
    "SELECT ts, price, dist250, dist1260, real_dist, score, level FROM signals ORDER BY ts DESC LIMIT 1",
  ).first<SignalRow>();
  const prevClose = await env.DB.prepare(
    "SELECT close FROM daily_close WHERE pair = 'EURBRL' AND date < ? ORDER BY date DESC LIMIT 1",
  )
    .bind(today.date)
    .first<{ close: number }>();
  const epoch = await getState<EpochState>(env.DB, "epoch_state");
  const lastSummary = (await getState<number>(env.DB, "last_summary_ts")) ?? now - 86_400_000;
  const { results: held } = await env.DB.prepare(
    "SELECT ts, context FROM alerts WHERE delivered = 0 AND ts > ? AND kind != 'sistema' ORDER BY ts",
  )
    .bind(lastSummary)
    .all<{ ts: number; context: string }>();
  const heldLines = held
    .map((a) => ({ ts: a.ts, ...(JSON.parse(a.context) as { title?: string; held?: string | null }) }))
    .filter((a) => a.held && a.held !== "dry_run")
    .map((a) => {
      const t = brt(a.ts);
      return `• ${a.title} — ${ddmm(t.date)} ${String(t.hour).padStart(2, "0")}h${String(t.minute).padStart(2, "0")}`;
    });

  const lines = [`☀️ <b>Resumo</b> · ${WEEKDAY_SHORT[today.weekday]} ${ddmm(today.date)}`];
  if (sig) {
    const change = prevClose
      ? ` (${pct(sig.price / prevClose.close - 1, 1, true)} desde o último fechamento)`
      : "";
    lines.push(`EUR/BRL ${rate(sig.price)}${change}`);
    lines.push(
      epoch?.active && epoch.startTs
        ? `Boa época ativa desde ${ddmm(brt(epoch.startTs).date)} · nível ${LEVEL_NAME[epoch.levelAlerted ?? "boa"]}`
        : "Fora de boa época",
    );
    lines.push(
      `12 meses ${pct(sig.dist250, 1, true)} · 5 anos ${pct(sig.dist1260, 1, true)} · ` +
        `história ${pct(sig.real_dist, 1, true)} (corrigida pela inflação)`,
    );
    lines.push(`Score de curto prazo: ${Math.round(sig.score)}/100`);
  } else {
    lines.push("Ainda sem sinal calculado (coleta ou histórico pendente).");
  }
  if (heldLines.length > 0) lines.push("", "<b>Durante a noite</b>", ...heldLines);

  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  await api.sendMessage(env.TELEGRAM_CHAT_ID, lines.join("\n"));
  await setState(env.DB, "last_summary_ts", now, now);
}
