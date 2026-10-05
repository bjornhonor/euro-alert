import { outcomeFrom, type ScoreSummary, summarize, WINDOWS } from "./outcomes";

export { outcomeFrom, summarize, WINDOWS, type ScoreSummary };

/** Atualiza `alert_outcomes` dos inícios de época ainda sem a janela de 6 meses fechada. */
export async function updateOutcomes(db: D1Database, now: number): Promise<number> {
  const { results: pending } = await db
    .prepare(
      "SELECT a.id, a.ts FROM alerts a LEFT JOIN alert_outcomes o ON o.alert_id = a.id " +
        "WHERE a.kind = 'epoca_inicio' AND (o.alert_id IS NULL OR o.avg_6m IS NULL)",
    )
    .all<{ id: number; ts: number }>();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO alert_outcomes (alert_id, avg_1m, avg_3m, avg_6m, min_3m, updated) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const writes: D1PreparedStatement[] = [];
  for (const a of pending) {
    const date = new Date(a.ts - 3 * 3600_000).toISOString().slice(0, 10);
    const { results } = await db
      .prepare("SELECT close FROM daily_close WHERE pair = 'EURBRL' AND date > ? ORDER BY date LIMIT ?")
      .bind(date, WINDOWS.m6)
      .all<{ close: number }>();
    const o = outcomeFrom(results.map((r) => r.close));
    writes.push(stmt.bind(a.id, o.avg1m, o.avg3m, o.avg6m, o.min3m, now));
  }
  for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));
  return writes.length;
}

/** Placar das épocas que começaram desde `sinceTs`. */
export async function loadScore(db: D1Database, sinceTs: number): Promise<ScoreSummary> {
  const { results } = await db
    .prepare(
      "SELECT a.price, o.avg_3m AS avg3m, o.min_3m AS min3m FROM alerts a " +
        "LEFT JOIN alert_outcomes o ON o.alert_id = a.id WHERE a.kind = 'epoca_inicio' AND a.ts >= ?",
    )
    .bind(sinceTs)
    .all<{ price: number; avg3m: number | null; min3m: number | null }>();
  return summarize(results);
}
