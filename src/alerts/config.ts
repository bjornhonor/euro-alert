import { EXIT_LEVEL, LEVELS } from "../engine/epoch";

/** Parâmetros dos alertas. Os padrões ficam aqui; a tabela `config` (chave 'alerts') sobrescreve. */
export interface AlertConfig {
  /** Distância da média de 12 meses que abre a época e os níveis seguintes. */
  levels: typeof LEVELS;
  /** Distância que fecha a época. */
  exitLevel: number;
  /** Leituras seguidas (de 15 min) para confirmar abertura, novo nível e fim. */
  confirmReadings: number;
  /** Euro subindo isso ou mais em 5 dias úteis = alerta de disparada. */
  surgeReturn: number;
  surge: boolean;
  seasonal: boolean;
  /** Notificações por dia (fora as de sistema); o excesso vai para o resumo das 8h. */
  maxPerDay: number;
  /** Modo silencioso: registra os alertas sem mandar (para conferir frequência e texto). */
  dryRun: boolean;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  levels: LEVELS,
  exitLevel: EXIT_LEVEL,
  confirmReadings: 2,
  surgeReturn: 0.03,
  surge: true,
  seasonal: true,
  maxPerDay: 3,
  dryRun: false,
};

export async function loadAlertConfig(db: D1Database): Promise<AlertConfig> {
  const row = await db.prepare("SELECT value FROM config WHERE key = 'alerts'").first<{ value: string }>();
  return row
    ? { ...DEFAULT_ALERT_CONFIG, ...(JSON.parse(row.value) as Partial<AlertConfig>) }
    : DEFAULT_ALERT_CONFIG;
}
