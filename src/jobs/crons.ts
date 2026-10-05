/** Crons em UTC (Brasília = UTC−3). Manter igual a `triggers.crons` no wrangler.jsonc (um teste confere). */
export const CRONS = {
  /** A cada 15 min em dias úteis: coleta, indicadores e regras de alerta. */
  tick: "*/15 * * * MON-FRI",
  /** 8h de Brasília em dias úteis: resumo diário. */
  summary: "0 11 * * MON-FRI",
  /** Sexta 18h de Brasília: relatório semanal. */
  weekly: "0 21 * * FRI",
  /** 3h de Brasília todo dia: manutenção. */
  maintenance: "0 6 * * *",
} as const;

export type JobName = keyof typeof CRONS;

export function jobForCron(cron: string): JobName | undefined {
  return (Object.keys(CRONS) as JobName[]).find((name) => CRONS[name] === cron);
}
