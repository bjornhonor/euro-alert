import { latestObservation, SERIES } from "../db/macro";
import { deflatedStats, monthlyMeans, recentCloses, updateDeflated } from "../db/series";
import { getState, setState } from "../db/state";
import { FIVE_YEARS } from "../engine/epoch";
import { kByMonth, type RealContext } from "../engine/real-rate";
import { seasonalIndex, type SeasonalIndex } from "../engine/seasonality";
import { computeSignal, type Signal } from "../engine/signal";
import { brt, floorTo15Min } from "../lib/time";
import { lastRates } from "../db/rates";
import { type Pair, type Quote } from "../providers/types";

/** Fechamentos lidos por coleta: 5 anos + folga para a inclinação e o RSI. */
const CLOSES_TO_READ = FIVE_YEARS + 140;

interface KToday {
  month: string;
  k: number;
}

/**
 * Calcula os indicadores com o preço ao vivo e grava em `signals`. Devolve o sinal, ou
 * undefined se ainda não há histórico suficiente (falta o backfill ou o cálculo da história).
 */
export async function computeAndStoreSignal(
  env: Env,
  now: number,
  quotes: readonly Quote[],
): Promise<Signal | undefined> {
  const signal = await buildSignal(env, now, quotes);
  if (!signal || !signal.real) return signal;
  await storeSignal(env, now, signal);
  return signal;
}

/** Sinal com a última cotação salva de cada par (para comandos e reenvios), sem gravar. */
export async function latestSignal(env: Env, now: number): Promise<{ signal?: Signal; quotes: Quote[] }> {
  const quotes: Quote[] = Object.values(await lastRates(env.DB)).map((r) => ({
    pair: r.pair,
    mid: r.mid,
    ts: r.ts,
    source: r.source as Quote["source"],
  }));
  return { signal: await buildSignal(env, now, quotes), quotes };
}

/** Calcula os indicadores com o preço ao vivo, sem gravar. */
export async function buildSignal(
  env: Env,
  now: number,
  quotes: readonly Quote[],
): Promise<Signal | undefined> {
  const live = new Map(quotes.map((q) => [q.pair, q.mid]));
  const eur = live.get("EURBRL");
  if (eur === undefined) return undefined;
  const today = brt(now).date;

  const closesBefore = async (pair: Pair, n: number) =>
    (await recentCloses(env.DB, pair, n)).filter((c) => c.date < today).map((c) => c.close);
  const withLive = async (pair: Pair) => {
    const v = live.get(pair);
    return v === undefined ? undefined : [...(await closesBefore(pair, 25)), v];
  };

  const closes = await closesBefore("EURBRL", CLOSES_TO_READ);
  const kToday = await getState<KToday>(env.DB, "real_k");
  let real: RealContext | undefined;
  if (kToday) {
    const st = await deflatedStats(env.DB, "EURBRL", today, eur / kToday.k);
    const n = st.n + 1; // hoje entra na conta
    const mean = (kToday.k * (st.sum + eur / kToday.k)) / n;
    real = { mean, dist: eur / mean - 1, cheaperThan: st.above / n, days: n };
  }
  const seasonal = await getState<SeasonalIndex>(env.DB, "seasonality");
  const month = brt(now).month;

  const signal = computeSignal({
    closes,
    live: eur,
    real,
    seasonal: seasonal?.[month] ? { month, ...seasonal[month]! } : undefined,
    eurusd: await withLive("EURUSD"),
    usdbrl: await withLive("USDBRL"),
  });
  return signal;
}

async function storeSignal(env: Env, now: number, signal: Signal): Promise<void> {
  if (!signal.real) return;

  const { epoch: e, score: s } = signal;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO signals (ts, price, dist250, pct250, dist1260, pct1260, real_dist, real_pct, " +
      "slope250, above_sma20, above_sma50, score, components, level, extra) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
  )
    .bind(
      floorTo15Min(now),
      e.price,
      e.dist250,
      e.pct250,
      e.dist1260,
      e.pct1260,
      signal.real.dist,
      signal.real.cheaperThan,
      e.slope250,
      e.aboveSma20 ? 1 : 0,
      e.aboveSma50 ? 1 : 0,
      s.score,
      JSON.stringify({ ...s.components, z20: s.z20, pct90: s.pct90, rsi: s.rsi, sd60: s.sd60, ret5: s.ret5 }),
      e.level,
      JSON.stringify({
        sma250: e.sma250,
        sma1260: e.sma1260,
        realMean: signal.real.mean,
        realDays: signal.real.days,
        seasonal: signal.seasonal,
        projection: signal.projection,
        decomposition: signal.decomposition,
      }),
    )
    .run();
}

/**
 * Uma vez por dia: K(mês) a partir do IPCA e da inflação do euro, o valor deflacionado de cada
 * fechamento (só dos meses em que K mudou, mais o mês atual e o anterior) e a sazonalidade.
 */
export async function refreshHistory(env: Env, now: number): Promise<void> {
  const { results: ipca } = await env.DB.prepare(
    "SELECT date, value FROM macro_series WHERE series = ? ORDER BY date",
  )
    .bind(SERIES.ipca)
    .all<{ date: string; value: number }>();
  const { results: hicp } = await env.DB.prepare(
    "SELECT date, value FROM macro_series WHERE series = ? ORDER BY date",
  )
    .bind(SERIES.hicp)
    .all<{ date: string; value: number }>();
  if (ipca.length < 13 || hicp.length < 13 || !(await latestObservation(env.DB, SERIES.ipca))) {
    throw new Error("história: faltam IPCA ou inflação do euro (rode o backfill)");
  }

  const thisMonth = brt(now).date.slice(0, 7);
  const k = kByMonth(ipca, hicp, thisMonth);
  const previous = new Map(
    Object.entries((await getState<Record<string, number>>(env.DB, "k_months")) ?? {}),
  );
  const prevMonth = [...k.keys()].filter((m) => m < thisMonth).at(-1);
  const changed = new Map(
    [...k].filter(([m, v]) => m === thisMonth || m === prevMonth || previous.get(m) !== v),
  );
  await updateDeflated(env.DB, "EURBRL", changed);
  await setState(env.DB, "k_months", Object.fromEntries(k), now);
  await setState(env.DB, "real_k", { month: thisMonth, k: k.get(thisMonth)! } satisfies KToday, now);

  await setState(env.DB, "seasonality", seasonalIndex(await monthlyMeans(env.DB, "EURBRL")), now);
}
