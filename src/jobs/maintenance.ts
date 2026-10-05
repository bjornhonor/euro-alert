import { latestObservation, SERIES, upsertSeries } from "../db/macro";
import { consolidateDay, deleteRatesBefore } from "../db/rates";
import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { errorFields, log } from "../lib/log";
import { addDays, brt, brtDayBounds, isWeekdayDate } from "../lib/time";
import { fetchFocus, fetchSgs, SGS } from "../providers/bcb";
import { fetchEcbDepositRate, fetchHicp } from "../providers/euro-area";
import {
  effectiveBrlPerEur,
  FEE_AMOUNTS,
  feeFor,
  type FeeModel,
  type FeeQuote,
  fetchFeeQuote,
  fitFeeModel,
  REFERENCE_AMOUNT,
} from "../providers/wise-fees";
import { TelegramApi } from "../telegram/api";
import { sendSystemAlert } from "../telegram/notify";
import { refreshHistory } from "./signals";
import { updateOutcomes } from "../alerts/scorecard";
import { updatePredictions } from "../ai/run";

const DAY_MS = 86_400_000;
const RATES_RETENTION_MS = 90 * DAY_MS;
const TG_UPDATES_RETENTION_MS = 7 * DAY_MS;
/** Fechamento: refaz os últimos dias (idempotente) para cobrir uma manutenção que tenha falhado. */
const CONSOLIDATE_DAYS = 3;
/** A tarifa na referência de R$ 1.000 mudou mais que isso: avisa. */
export const FEE_CHANGE_ALERT = 0.1;
/** Séries que mudam pouco: só busca de novo depois desse intervalo. */
const ECB_CACHE_MS = 7 * DAY_MS;
const HICP_CACHE_MS = 7 * DAY_MS;

type Task = [name: string, run: () => Promise<void>];

/**
 * Manutenção das 3h. Cada tarefa roda isolada: a falha de uma fonte não impede as outras.
 */
export async function maintenance(env: Env, deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const tasks: Task[] = [
    ["fechamento", () => consolidate(env, now)],
    ["limpeza", () => cleanup(env, now)],
    ["tarifa", () => updateFees(env, deps, now)],
    ["selic_ipca", () => updateBcb(env, deps, now)],
    ["focus", () => updateFocus(env, deps)],
    ["bce", () => cached(env, now, "fetched_ecb_dfr", ECB_CACHE_MS, () => updateEcb(env, deps))],
    [
      "inflacao_euro",
      () => cached(env, now, "fetched_hicp", HICP_CACHE_MS, () => updateHicp(env, deps, now)),
    ],
    ["historia", () => refreshHistory(env, now)], // depois do IPCA e da inflação do euro
    ["placar", async () => void (await updateOutcomes(env.DB, now))], // depois do fechamento do dia
    ["placar_ia", () => updatePredictions(env.DB, now)],
    ["ola", () => hello(env, deps, now)],
  ];
  const failed: string[] = [];
  for (const [name, run] of tasks) {
    try {
      await run();
    } catch (err) {
      failed.push(name);
      log("error", "manutenção: tarefa falhou", { task: name, ...errorFields(err) });
    }
  }
  await setState(env.DB, "last_maintenance", { ts: now, failed }, now);
}

async function cached(env: Env, now: number, key: string, ttl: number, run: () => Promise<void>) {
  const last = await getState<number>(env.DB, key);
  if (last !== undefined && now - last < ttl) return;
  await run();
  await setState(env.DB, key, now, now);
}

/** A última cotação de cada dia útil (horário de Brasília) vira o fechamento do dia. */
async function consolidate(env: Env, now: number) {
  const today = brt(now).date;
  for (let i = 1; i <= CONSOLIDATE_DAYS; i++) {
    const date = addDays(today, -i);
    if (!isWeekdayDate(date)) continue;
    const [start, end] = brtDayBounds(date);
    await consolidateDay(env.DB, date, start, end);
  }
}

async function cleanup(env: Env, now: number) {
  await deleteRatesBefore(env.DB, now - RATES_RETENTION_MS);
  await env.DB.prepare("DELETE FROM tg_updates WHERE ts < ?")
    .bind(now - TG_UPDATES_RETENTION_MS)
    .run();
}

/** Consulta a comparação da Wise, guarda as cotações e ajusta a reta de tarifa. */
async function updateFees(env: Env, deps: Deps, now: number) {
  const quotes: FeeQuote[] = [];
  for (const amount of FEE_AMOUNTS) {
    const q = await fetchFeeQuote(deps.fetch, amount);
    if (q) quotes.push(q);
  }
  if (quotes.length > 0) {
    const stmt = env.DB.prepare(
      "INSERT OR REPLACE INTO fee_quotes (ts, amount_brl, fee_brl, rate, received_eur) VALUES (?, ?, ?, ?, ?)",
    );
    await env.DB.batch(quotes.map((q) => stmt.bind(now, q.amountBrl, q.feeBrl, q.rate, q.receivedEur)));
  }
  const model = fitFeeModel(quotes);
  if (!model) throw new Error(`tarifa: só ${quotes.length} cotação(ões) da Wise`);

  const previous = await getState<FeeModel>(env.DB, "fee_model");
  await setState(env.DB, "fee_model", model, now);
  if (!previous) return;
  const before = feeFor(previous, REFERENCE_AMOUNT);
  const after = feeFor(model, REFERENCE_AMOUNT);
  if (Math.abs(after / before - 1) > FEE_CHANGE_ALERT) {
    const mid = 1 / (quotes.find((q) => q.amountBrl === REFERENCE_AMOUNT) ?? quotes[0]!).rate;
    await sendSystemAlert(
      env,
      deps,
      `ℹ️ A tarifa da Wise mudou: para R$ ${REFERENCE_AMOUNT} era R$ ${before.toFixed(2)}, agora R$ ${after.toFixed(2)} ` +
        `(custo efetivo ~R$ ${effectiveBrlPerEur(model, mid).toFixed(2)}/€).`,
    );
  }
}

/** Selic meta (últimos 15 dias) e IPCA (últimos 13 meses). */
async function updateBcb(env: Env, deps: Deps, now: number) {
  const today = brt(now).date;
  const selic = await fetchSgs(deps.fetch, SGS.selic, addDays(today, -15), today, today);
  await upsertSeries(env.DB, SERIES.selic, selic);
  const ipca = await fetchSgs(deps.fetch, SGS.ipca, addDays(today, -400), today, today);
  await upsertSeries(env.DB, SERIES.ipca, ipca);
}

async function updateFocus(env: Env, deps: Deps) {
  for (const f of await fetchFocus(deps.fetch)) {
    await upsertSeries(env.DB, SERIES.focusCambio(f.year), [{ date: f.date, value: f.median }]);
  }
}

async function updateEcb(env: Env, deps: Deps) {
  await upsertSeries(env.DB, SERIES.ecbDfr, await fetchEcbDepositRate(deps.fetch));
}

/** Busca a partir do último mês salvo (ou 2 anos, se a série estiver vazia). */
async function updateHicp(env: Env, deps: Deps, now: number) {
  const last = await latestObservation(env.DB, SERIES.hicp);
  const since = (last?.date ?? addDays(brt(now).date, -730)).slice(0, 7);
  await upsertSeries(env.DB, SERIES.hicp, await fetchHicp(deps.fetch, since));
}

/** "Olá" uma única vez: prova de que cron, banco e Telegram estão ligados. */
async function hello(env: Env, deps: Deps, now: number) {
  if (await getState<boolean>(env.DB, "hello_sent")) return;
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  await api.sendMessage(
    env.TELEGRAM_CHAT_ID,
    `👋 Olá! O <b>Euro Alert</b> está no ar (${env.ENVIRONMENT}). Cron, banco e Telegram funcionando.`,
    { silent: true },
  );
  await setState(env.DB, "hello_sent", true, now);
  log("info", "olá enviado no Telegram");
}
