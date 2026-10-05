type Level = "debug" | "info" | "warn" | "error";

/** Log em JSON, uma linha por evento (aparece no Workers Logs). */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.message, name: err.name };
  return { error: String(err) };
}
