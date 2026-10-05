import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { type Signal } from "../engine/signal";
import { lastRates } from "../db/rates";
import { buildSignal } from "../jobs/signals";
import { type Quote } from "../providers/types";
import { log } from "../lib/log";
import { brt, brtDayBounds, isAlertWindow } from "../lib/time";
import { type FeeModel } from "../providers/wise-fees";
import { TelegramApi } from "../telegram/api";
import { alertButtons, alertTitle, type MessageContext, renderAlert } from "../telegram/templates";
import { type AlertConfig, loadAlertConfig } from "./config";
import { type EpochState, evaluate, INITIAL_STATE, isFirstBusinessDay, type RuleEvent } from "./rules";

export type HoldReason = "dry_run" | "silenciado" | "fora_do_horario" | "limite";

/** Envia agora ou segura para o resumo das 8h. */
export async function holdReason(env: Env, now: number, cfg: AlertConfig): Promise<HoldReason | undefined> {
  if (cfg.dryRun) return "dry_run";
  const muteUntil = await getState<number>(env.DB, "mute_until");
  if (muteUntil && muteUntil > now) return "silenciado";
  if (!isAlertWindow(now, Number(env.ALERT_START_HOUR), Number(env.ALERT_END_HOUR))) return "fora_do_horario";
  const [dayStart] = brtDayBounds(brt(now).date);
  const sent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM alerts WHERE delivered = 1 AND kind != 'sistema' AND ts >= ?",
  )
    .bind(dayStart)
    .first<{ n: number }>();
  if ((sent?.n ?? 0) >= cfg.maxPerDay) return "limite";
  return undefined;
}

/** Abre, atualiza e fecha o episódio na tabela `epochs`. */
async function syncEpoch(
  env: Env,
  now: number,
  prev: EpochState,
  next: EpochState,
  events: RuleEvent[],
): Promise<EpochState> {
  const s = { ...next };
  for (const ev of events) {
    if (ev.kind === "epoca_inicio") {
      const res = await env.DB.prepare(
        "INSERT INTO epochs (start_ts, entry_price, min_price, min_dist, min_ts, max_level, source) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'live')",
      )
        .bind(s.startTs, s.entryPrice, s.minPrice, s.minDist, s.minTs, ev.level)
        .run();
      s.epochId = res.meta.last_row_id;
    } else if (ev.kind === "epoca_fim" && prev.epochId) {
      await env.DB.prepare(
        "UPDATE epochs SET end_ts = ?, min_price = ?, min_dist = ?, min_ts = ?, max_level = ? WHERE id = ?",
      )
        .bind(now, ev.minPrice, ev.minDist, ev.minTs, ev.levelReached, prev.epochId)
        .run();
    }
  }
  if (s.active && s.epochId && (s.minPrice !== prev.minPrice || s.levelAlerted !== prev.levelAlerted)) {
    await env.DB.prepare(
      "UPDATE epochs SET min_price = ?, min_dist = ?, min_ts = ?, max_level = ? WHERE id = ?",
    )
      .bind(s.minPrice, s.minDist, s.minTs, s.levelAlerted, s.epochId)
      .run();
  }
  return s;
}

/**
 * Roda as regras com o sinal da coleta, registra e envia os alertas. Cada alerta fica em
 * `alerts`; os retidos (fora do horário, limite, silêncio) vão para o resumo das 8h.
 */
export async function processAlerts(env: Env, deps: Deps, now: number, signal: Signal): Promise<RuleEvent[]> {
  const cfg = await loadAlertConfig(env.DB);
  const prev = (await getState<EpochState>(env.DB, "epoch_state")) ?? INITIAL_STATE;
  const today = brt(now).date;
  const { state: evaluated, events } = evaluate(
    prev,
    {
      ts: now,
      date: today,
      price: signal.epoch.price,
      dist250: signal.epoch.dist250,
      ret5: signal.score.ret5,
      firstBusinessDay: isFirstBusinessDay(today),
    },
    cfg,
  );
  const state = await syncEpoch(env, now, prev, evaluated, events);
  await setState(env.DB, "epoch_state", state, now);
  if (events.length === 0) return events;

  const ctx: MessageContext = {
    signal,
    today,
    feeModel: await getState<FeeModel>(env.DB, "fee_model"),
    epochStart:
      state.startTs && state.entryPrice
        ? { date: brt(state.startTs).date, price: state.entryPrice }
        : undefined,
    seasonalIndex: await getState(env.DB, "seasonality"),
  };
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);

  for (const ev of events) {
    const text = renderAlert(ev, ctx, cfg.levels);
    const held = await holdReason(env, now, cfg);
    const res = await env.DB.prepare(
      "INSERT INTO alerts (ts, kind, level, price, dist250, epoch_id, context, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    )
      .bind(
        now,
        ev.kind,
        "level" in ev ? ev.level : null,
        signal.epoch.price,
        signal.epoch.dist250,
        state.epochId ?? prev.epochId,
        JSON.stringify({ title: alertTitle(ev), text, event: ev, held: held ?? null }),
      )
      .run();
    const id = res.meta.last_row_id;
    log("info", "alerta", { kind: ev.kind, held: held ?? null, id });
    if (held) continue;
    const withButtons = ev.kind !== "sazonal" && ev.kind !== "epoca_fim";
    const msg = await api.sendMessage(env.TELEGRAM_CHAT_ID, text, {
      replyMarkup: withButtons ? alertButtons(id) : undefined,
    });
    await env.DB.prepare("UPDATE alerts SET delivered = 1, tg_message_id = ? WHERE id = ?")
      .bind(msg.message_id, id)
      .run();
  }
  return events;
}

/**
 * Reenvia o último alerta (não histórico) com o modelo de mensagem atual e o preço mais recente,
 * sem registrar um alerta novo. Serve para ver como fica o texto depois de mexer nos modelos.
 */
export async function resendLastAlert(
  env: Env,
  deps: Deps,
): Promise<{ id: number; kind: string } | undefined> {
  const row = await env.DB.prepare(
    "SELECT id, kind, context FROM alerts WHERE kind != 'sistema' AND json_extract(context, '$.event') IS NOT NULL " +
      "ORDER BY id DESC LIMIT 1",
  ).first<{ id: number; kind: string; context: string }>();
  if (!row) return undefined;
  const ev = (JSON.parse(row.context) as { event: RuleEvent }).event;
  const now = deps.clock.now();
  const quotes: Quote[] = Object.values(await lastRates(env.DB)).map((r) => ({
    pair: r.pair,
    mid: r.mid,
    ts: r.ts,
    source: r.source as Quote["source"],
  }));
  const signal = await buildSignal(env, now, quotes);
  if (!signal) throw new Error("sem sinal para montar a mensagem");
  const cfg = await loadAlertConfig(env.DB);
  const state = (await getState<EpochState>(env.DB, "epoch_state")) ?? INITIAL_STATE;
  const text = renderAlert(
    ev,
    {
      signal,
      today: brt(now).date,
      feeModel: await getState<FeeModel>(env.DB, "fee_model"),
      epochStart:
        state.startTs && state.entryPrice
          ? { date: brt(state.startTs).date, price: state.entryPrice }
          : undefined,
      seasonalIndex: await getState(env.DB, "seasonality"),
    },
    cfg.levels,
  );
  const withButtons = ev.kind !== "sazonal" && ev.kind !== "epoca_fim";
  await new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch).sendMessage(env.TELEGRAM_CHAT_ID, text, {
    replyMarkup: withButtons ? alertButtons(row.id) : undefined,
  });
  return { id: row.id, kind: row.kind };
}
