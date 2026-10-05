import { type MonthlyMean } from "../engine/seasonality";
import { type Pair } from "../providers/types";

export interface DailyClose {
  date: string;
  close: number;
}

/** Últimos `limit` fechamentos de um par, do mais antigo ao mais novo. */
export async function recentCloses(db: D1Database, pair: Pair, limit: number): Promise<DailyClose[]> {
  const { results } = await db
    .prepare("SELECT date, close FROM daily_close WHERE pair = ? ORDER BY date DESC LIMIT ?")
    .bind(pair, limit)
    .all<DailyClose>();
  return results.reverse();
}

/** Média do fechamento por mês (para a sazonalidade). */
export async function monthlyMeans(db: D1Database, pair: Pair): Promise<MonthlyMean[]> {
  const { results } = await db
    .prepare(
      "SELECT substr(date, 1, 7) AS month, AVG(close) AS mean FROM daily_close WHERE pair = ? GROUP BY month ORDER BY month",
    )
    .bind(pair)
    .all<MonthlyMean>();
  return results;
}

/**
 * Atualiza `deflated = close ÷ K(mês)` dos meses informados. Um UPDATE por mês, em lotes.
 * Valores de K são gerados pelo app (números), então vão como parâmetros normais.
 */
export async function updateDeflated(
  db: D1Database,
  pair: Pair,
  k: ReadonlyMap<string, number>,
): Promise<void> {
  // Faixa de datas (e não LIKE) para usar o índice da chave primária: lê só as linhas do mês.
  const stmt = db.prepare(
    "UPDATE daily_close SET deflated = close / ?1 WHERE pair = ?2 AND date >= ?3 AND date <= ?4",
  );
  const months = [...k];
  for (let i = 0; i < months.length; i += 50) {
    await db.batch(months.slice(i, i + 50).map(([m, v]) => stmt.bind(v, pair, `${m}-01`, `${m}-31`)));
  }
}

export interface DeflatedStats {
  n: number;
  sum: number;
  /** Quantos dias têm d > limite. */
  above: number;
}

/** Soma, contagem e quantos dias da história (antes de `beforeDate`) ficam acima de `threshold`. */
export async function deflatedStats(
  db: D1Database,
  pair: Pair,
  beforeDate: string,
  threshold: number,
): Promise<DeflatedStats> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(deflated), 0) AS sum, COALESCE(SUM(deflated > ?3), 0) AS above " +
        "FROM daily_close WHERE pair = ?1 AND date < ?2 AND deflated IS NOT NULL",
    )
    .bind(pair, beforeDate, threshold)
    .first<DeflatedStats>();
  return row ?? { n: 0, sum: 0, above: 0 };
}
