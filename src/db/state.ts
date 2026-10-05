/** Estado chave-valor do app (tabela `state`), com o valor guardado como JSON. */
export async function getState<T>(db: D1Database, key: string): Promise<T | undefined> {
  const row = await db.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export async function setState(db: D1Database, key: string, value: unknown, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO state (key, value, updated) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated",
    )
    .bind(key, JSON.stringify(value), now)
    .run();
}
