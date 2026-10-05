import { type AlertConfig, loadAlertConfig } from "../alerts/config";
import { type EpochState } from "../alerts/rules";
import { loadScore } from "../alerts/scorecard";
import { renderNews } from "../ai/news-analyst";
import { newsAnalysis } from "../ai/run";
import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { YEAR } from "../engine/epoch";
import { latestSignal } from "../jobs/signals";
import { brt, brtDayBounds } from "../lib/time";
import { type FeeModel } from "../providers/wise-fees";
import { TelegramApi } from "./api";
import { buildChartConfig, chartUrl, type ChartRange, parseRange, RANGE_DAYS } from "./chart";
import { type EpochRow, HELP, renderEpochs, renderNow, renderScore, renderStatus } from "./views";

const DAY_MS = 86_400_000;
const brtDate = (ms: number) => brt(ms).date;

/** "3d", "12h", "2" (dias) → milissegundos. Padrão: 24h. Máximo: 30 dias. */
export function parseDuration(arg: string | undefined): number | undefined {
  if (!arg) return DAY_MS;
  const m = /^(\d+(?:[.,]\d+)?)\s*(d|h)?$/i.exec(arg.trim());
  if (!m) return undefined;
  const n = Number(m[1]!.replace(",", "."));
  const ms = (m[2]?.toLowerCase() === "h" ? 3600_000 : DAY_MS) * n;
  return ms > 0 && ms <= 30 * DAY_MS ? ms : undefined;
}

async function loadEpochs(db: D1Database, limit: number): Promise<EpochRow[]> {
  const { results } = await db
    .prepare(
      "SELECT start_ts, end_ts, entry_price, min_price, min_dist, min_ts, max_level FROM epochs " +
        "ORDER BY start_ts DESC LIMIT ?",
    )
    .bind(limit)
    .all<{
      start_ts: number;
      end_ts: number | null;
      entry_price: number;
      min_price: number;
      min_dist: number;
      min_ts: number;
      max_level: EpochRow["maxLevel"];
    }>();
  return results.map((r) => ({
    start: brtDate(r.start_ts),
    end: r.end_ts ? brtDate(r.end_ts) : null,
    entryPrice: r.entry_price,
    minPrice: r.min_price,
    minDist: r.min_dist,
    minDate: brtDate(r.min_ts),
    maxLevel: r.max_level,
  }));
}

/** Manda o gráfico do período (com as épocas sombreadas). */
export async function sendChart(env: Env, deps: Deps, range: ChartRange): Promise<void> {
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  const { results } = await env.DB.prepare(
    "SELECT date, close FROM daily_close WHERE pair = 'EURBRL' ORDER BY date DESC LIMIT ?",
  )
    .bind(RANGE_DAYS[range] + YEAR)
    .all<{ date: string; close: number }>();
  const rows = results.reverse();
  const now = deps.clock.now();
  const { signal } = await latestSignal(env, now);
  const today = brtDate(now);
  if (signal && rows.at(-1)?.date !== today) rows.push({ date: today, close: signal.epoch.price });
  const epochs = (await loadEpochs(env.DB, 40)).map((e) => ({ start: e.start, end: e.end }));
  const url = await chartUrl(
    deps.fetch,
    buildChartConfig({ dates: rows.map((r) => r.date), prices: rows.map((r) => r.close), range, epochs }),
  );
  await api.sendPhoto(env.TELEGRAM_CHAT_ID, url, `📈 EUR/BRL · use /grafico 90d, 1a ou 5a`);
}

/** Teclado do /alertas com o estado atual de cada opção. */
export function alertsKeyboard(cfg: AlertConfig) {
  const on = (b: boolean) => (b ? "✅" : "⬜");
  return {
    inline_keyboard: [
      [{ text: `${on(cfg.surge)} Euro disparando (+3% em 5 dias)`, callback_data: "cfg:surge" }],
      [{ text: `${on(cfg.seasonal)} Aviso sazonal (junho e dezembro)`, callback_data: "cfg:seasonal" }],
      [{ text: `${on(cfg.dryRun)} Modo silencioso (só registra)`, callback_data: "cfg:dryRun" }],
    ],
  };
}

export async function toggleAlertOption(
  db: D1Database,
  key: "surge" | "seasonal" | "dryRun",
): Promise<AlertConfig> {
  const row = await db.prepare("SELECT value FROM config WHERE key = 'alerts'").first<{ value: string }>();
  const saved = row ? (JSON.parse(row.value) as Partial<AlertConfig>) : {};
  const current = await loadAlertConfig(db);
  const next = { ...saved, [key]: !current[key] };
  await db
    .prepare(
      "INSERT INTO config (key, value) VALUES ('alerts', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(JSON.stringify(next))
    .run();
  return loadAlertConfig(db);
}

/** Responde um comando de texto. Só é chamado para o seu chat (o webhook já filtrou). */
export async function handleCommand(text: string, env: Env, deps: Deps): Promise<void> {
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  const send = (html: string, replyMarkup?: unknown) =>
    api.sendMessage(env.TELEGRAM_CHAT_ID, html, { replyMarkup });
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd?.split("@")[0]?.toLowerCase() ?? "";
  const now = deps.clock.now();

  switch (cmd) {
    case "/start":
      return void (await send(
        "Olá! Sou o <b>Euro Alert</b>. Aviso aqui quando o euro entrar numa boa época de compra.\n\n" + HELP,
      ));
    case "/ajuda":
    case "/help":
      return void (await send(HELP));

    case "/agora": {
      const { signal, quotes } = await latestSignal(env, now);
      if (!signal) return void (await send("Ainda sem dados suficientes para calcular o momento do euro."));
      const eur = quotes.find((q) => q.pair === "EURBRL")!;
      const state = await getState<EpochState>(env.DB, "epoch_state");
      const t = brt(eur.ts);
      return void (await send(
        renderNow({
          signal,
          today: brtDate(now),
          feeModel: await getState<FeeModel>(env.DB, "fee_model"),
          epoch:
            state?.active && state.startTs
              ? { start: brtDate(state.startTs), level: state.levelAlerted ?? "boa" }
              : undefined,
          updated: { hour: t.hour, minute: t.minute, source: eur.source },
        }),
      ));
    }

    case "/epoca": {
      const { signal } = await latestSignal(env, now);
      const epochs = await loadEpochs(env.DB, 6);
      const state = await getState<EpochState>(env.DB, "epoch_state");
      // a época aberta usa o nível já avisado ao vivo (pode ser mais fundo que o dos fechamentos)
      if (epochs[0] && epochs[0].end === null && state?.levelAlerted) epochs[0].maxLevel = state.levelAlerted;
      return void (await send(
        renderEpochs({
          today: brtDate(now),
          price: signal?.epoch.price ?? NaN,
          dist250: signal?.epoch.dist250 ?? NaN,
          epochs,
        }),
      ));
    }

    case "/grafico": {
      const range = parseRange(args[0]);
      if (!range) return void (await send("Use /grafico 90d, /grafico 1a ou /grafico 5a."));
      return sendChart(env, deps, range);
    }

    case "/placar":
      return void (await send(
        renderScore({
          year: await loadScore(env.DB, now - 365 * DAY_MS),
          fiveYears: await loadScore(env.DB, now - 5 * 365.25 * DAY_MS),
          all: await loadScore(env.DB, 0),
        }),
      ));

    case "/pausar": {
      const ms = parseDuration(args[0]);
      if (!ms) return void (await send("Use /pausar 24h, /pausar 3d (até 30 dias)."));
      await setState(env.DB, "mute_until", now + ms, now);
      const until = brt(now + ms);
      return void (await send(
        `🔕 Alertas pausados até ${until.date.slice(8, 10)}/${until.date.slice(5, 7)} às ` +
          `${String(until.hour).padStart(2, "0")}h${String(until.minute).padStart(2, "0")}. ` +
          "O que acontecer vai para o resumo das 8h. /retomar para voltar antes.",
      ));
    }
    case "/retomar":
      await setState(env.DB, "mute_until", null, now);
      return void (await send("🔔 Alertas ligados de novo."));

    case "/alertas":
      return void (await send(
        "⚙️ <b>Alertas opcionais</b>\nToque para ligar ou desligar. Os de boa época estão sempre ligados.",
        alertsKeyboard(await loadAlertConfig(env.DB)),
      ));

    case "/status":
      return void (await send(await statusText(env, now)));

    case "/analise":
    case "/macro":
      return sendNewsAnalysis(env, deps);

    default:
      return void (await send("Não conheço esse comando. /ajuda mostra a lista."));
  }
}

/**
 * A análise de notícias (botão 🤖 e /analise). A busca leva de 15 a 40 s: avisa que está
 * pesquisando e depois troca a mensagem pelo resultado.
 */
export async function sendNewsAnalysis(env: Env, deps: Deps, alertId?: number): Promise<void> {
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  const wait = await api.sendMessage(
    env.TELEGRAM_CHAT_ID,
    "🔎 Pesquisando as notícias que estão mexendo com o euro… (leva até 1 minuto)",
  );
  const res = await newsAnalysis(env, deps, { alertId });
  const t = res ? brt(res.ts) : undefined;
  await api.editMessageText(
    env.TELEGRAM_CHAT_ID,
    wait.message_id,
    res && t
      ? renderNews(res.analysis, { date: t.date, hour: t.hour, minute: t.minute })
      : "🤖 A IA não conseguiu pesquisar agora. Tente de novo em alguns minutos.",
  );
}

async function statusText(env: Env, now: number): Promise<string> {
  const lastTick = await env.DB.prepare(
    "SELECT ts, source FROM rates WHERE pair = 'EURBRL' ORDER BY ts DESC LIMIT 1",
  ).first<{ ts: number; source: string }>();
  const [dayStart] = brtDayBounds(brtDate(now));
  const ticks = await env.DB.prepare("SELECT COUNT(*) AS n FROM rates WHERE pair = 'EURBRL' AND ts >= ?")
    .bind(dayStart)
    .first<{ n: number }>();
  const alerts = await env.DB.prepare(
    "SELECT SUM(delivered = 1) AS sent, SUM(delivered = 0) AS held FROM alerts WHERE kind != 'sistema' AND ts >= ?",
  )
    .bind(dayStart)
    .first<{ sent: number | null; held: number | null }>();
  const maint = await getState<{ ts: number; failed: string[] }>(env.DB, "last_maintenance");
  const mute = await getState<number | null>(env.DB, "mute_until");
  const incident = await getState<{ since: number } | null>(env.DB, "watchdog_incident");
  const cfg = await loadAlertConfig(env.DB);
  const t = lastTick ? brt(lastTick.ts) : undefined;
  const lastTickTs = await getState<number>(env.DB, "last_tick");
  const tickClock = lastTickTs ? brt(lastTickTs) : t;
  return renderStatus({
    lastTick: tickClock
      ? {
          hour: tickClock.hour,
          minute: tickClock.minute,
          minutesAgo: Math.round((now - (lastTickTs ?? lastTick!.ts)) / 60_000),
          source: lastTick?.source,
        }
      : undefined,
    ticksToday: ticks?.n ?? 0,
    maintenance: maint ? { ...pickClock(maint.ts), failed: maint.failed } : undefined,
    alertsToday: { sent: alerts?.sent ?? 0, held: alerts?.held ?? 0 },
    muteUntil: mute && mute > now ? { date: brtDate(mute), ...pickClock(mute) } : undefined,
    dryRun: cfg.dryRun,
    incidentSince: incident ? pickClock(incident.since) : undefined,
  });
}

const pickClock = (ms: number) => {
  const b = brt(ms);
  return { hour: b.hour, minute: b.minute };
};
