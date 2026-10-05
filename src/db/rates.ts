import { type Pair, type Quote } from "../providers/types";

export async function insertRates(db: D1Database, slotTs: number, quotes: readonly Quote[]): Promise<void> {
  if (quotes.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO rates (pair, ts, mid, bid, ask, source) VALUES (?, ?, ?, ?, ?, ?)",
  );
  await db.batch(quotes.map((q) => stmt.bind(q.pair, slotTs, q.mid, q.bid ?? null, q.ask ?? null, q.source)));
}

export interface LastRate {
  pair: Pair;
  ts: number;
  mid: number;
  source: string;
}

/** Última cotação salva de cada par. */
export async function lastRates(db: D1Database): Promise<Partial<Record<Pair, LastRate>>> {
  const { results } = await db
    .prepare(
      "SELECT r.pair, r.ts, r.mid, r.source FROM rates r " +
        "JOIN (SELECT pair, MAX(ts) AS ts FROM rates GROUP BY pair) m ON m.pair = r.pair AND m.ts = r.ts",
    )
    .all<LastRate>();
  return Object.fromEntries(results.map((r) => [r.pair, r]));
}

/**
 * Fecha o dia: a última cotação de cada par dentro do dia de Brasília vira o fechamento
 * (`source = 'own'`). `startMs`/`endMs` delimitam o dia em UTC.
 */
export async function consolidateDay(
  db: D1Database,
  date: string,
  startMs: number,
  endMs: number,
): Promise<number> {
  const res = await db
    .prepare(
      "INSERT OR REPLACE INTO daily_close (pair, date, close, source) " +
        "SELECT r.pair, ?1, r.mid, 'own' FROM rates r " +
        "JOIN (SELECT pair, MAX(ts) AS ts FROM rates WHERE ts >= ?2 AND ts < ?3 GROUP BY pair) m " +
        "ON m.pair = r.pair AND m.ts = r.ts",
    )
    .bind(date, startMs, endMs)
    .run();
  return res.meta.changes;
}

export async function deleteRatesBefore(db: D1Database, ts: number): Promise<number> {
  const res = await db.prepare("DELETE FROM rates WHERE ts < ?").bind(ts).run();
  return res.meta.changes;
}
