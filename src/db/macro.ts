import { type Observation } from "../providers/bcb";

/** Nomes das séries em `macro_series`. */
export const SERIES = {
  selic: "selic", // Selic meta, % a.a. (SGS 432)
  ipca: "ipca", // IPCA, variação mensal em % (SGS 433), data = 1º dia do mês
  hicp: "hicp_ea", // inflação harmonizada da zona do euro, índice 2025 = 100, data = 1º dia do mês
  ecbDfr: "ecb_dfr", // taxa de depósito do BCE, % a.a., data da mudança
  focusCambio: (year: string) => `focus_cambio:${year}`, // mediana Focus do dólar no fim do ano
} as const;

export async function upsertSeries(
  db: D1Database,
  series: string,
  obs: readonly Observation[],
): Promise<void> {
  if (obs.length === 0) return;
  const stmt = db.prepare("INSERT OR REPLACE INTO macro_series (series, date, value) VALUES (?, ?, ?)");
  // D1 aceita lotes grandes, mas manter abaixo de ~100 por batch evita estourar limites.
  for (let i = 0; i < obs.length; i += 100) {
    await db.batch(obs.slice(i, i + 100).map((o) => stmt.bind(series, o.date, o.value)));
  }
}

export async function latestObservation(db: D1Database, series: string): Promise<Observation | undefined> {
  return (
    (await db
      .prepare("SELECT date, value FROM macro_series WHERE series = ? ORDER BY date DESC LIMIT 1")
      .bind(series)
      .first<Observation>()) ?? undefined
  );
}
