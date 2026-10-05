import { type Level, LEVEL_RANK } from "../engine/epoch";
import { type AlertConfig } from "./config";

export { LEVEL_RANK };

export interface EpochState {
  active: boolean;
  epochId: number | null;
  startTs: number | null;
  entryPrice: number | null;
  minPrice: number | null;
  minDist: number | null;
  minTs: number | null;
  /** Nível mais fundo já avisado neste episódio (cada nível avisa uma vez). */
  levelAlerted: Level | null;
  /** Leituras seguidas confirmando a mudança pendente. */
  pendingEnter: number;
  pendingExit: number;
  pendingLevel: { level: Level; count: number } | null;
  lastSurgeTs: number | null;
  /** 'YYYY-MM' do último aviso sazonal. */
  lastSeasonal: string | null;
}

export const INITIAL_STATE: EpochState = {
  active: false,
  epochId: null,
  startTs: null,
  entryPrice: null,
  minPrice: null,
  minDist: null,
  minTs: null,
  levelAlerted: null,
  pendingEnter: 0,
  pendingExit: 0,
  pendingLevel: null,
  lastSurgeTs: null,
  lastSeasonal: null,
};

/** Uma leitura (a cada 15 min): só o que as regras precisam, tudo sobre o preço do euro. */
export interface Reading {
  ts: number;
  date: string; // 'YYYY-MM-DD' em Brasília
  price: number;
  dist250: number;
  /** Retorno em log de 5 dias úteis (com o preço ao vivo). */
  ret5: number;
  /** É o primeiro dia útil do mês? */
  firstBusinessDay: boolean;
}

export type RuleEvent =
  | { kind: "epoca_inicio"; level: Level }
  | { kind: "epoca_nivel"; level: Level; from: Level }
  | {
      kind: "epoca_fim";
      startTs: number;
      entryPrice: number;
      minPrice: number;
      minDist: number;
      minTs: number;
      levelReached: Level;
    }
  | { kind: "disparada"; ret5: number }
  | { kind: "sazonal"; month: 6 | 12 };

function levelOf(dist: number, cfg: AlertConfig): Level | null {
  if (!(dist <= cfg.levels.boa)) return null;
  if (dist <= cfg.levels.rara) return "rara";
  if (dist <= cfg.levels.muito_boa) return "muito_boa";
  return "boa";
}

const FIVE_DAYS_MS = 5 * 86_400_000;

/**
 * Regras dos alertas (função pura). A boa época abre quando a distância da média de 12 meses
 * fica ≤ −3% por `confirmReadings` leituras seguidas, avisa cada nível mais fundo uma vez
 * (também confirmado) e fecha quando volta a ≥ −1% (histerese). Mais disparada e sazonal.
 */
export function evaluate(
  prev: EpochState,
  r: Reading,
  cfg: AlertConfig,
): { state: EpochState; events: RuleEvent[] } {
  const s: EpochState = { ...prev };
  const events: RuleEvent[] = [];
  const level = levelOf(r.dist250, cfg);

  if (!s.active) {
    s.pendingEnter = level ? s.pendingEnter + 1 : 0;
    if (level && s.pendingEnter >= cfg.confirmReadings) {
      Object.assign(s, {
        active: true,
        startTs: r.ts,
        entryPrice: r.price,
        minPrice: r.price,
        minDist: r.dist250,
        minTs: r.ts,
        levelAlerted: level,
        pendingEnter: 0,
        pendingExit: 0,
        pendingLevel: null,
      });
      events.push({ kind: "epoca_inicio", level });
    }
  } else {
    if (r.price < (s.minPrice ?? Infinity))
      Object.assign(s, { minPrice: r.price, minDist: r.dist250, minTs: r.ts });

    if (r.dist250 >= cfg.exitLevel) {
      s.pendingExit++;
      s.pendingLevel = null;
      if (s.pendingExit >= cfg.confirmReadings) {
        events.push({
          kind: "epoca_fim",
          startTs: s.startTs!,
          entryPrice: s.entryPrice!,
          minPrice: s.minPrice!,
          minDist: s.minDist!,
          minTs: s.minTs!,
          levelReached: s.levelAlerted ?? "boa",
        });
        Object.assign(s, { ...INITIAL_STATE, lastSurgeTs: s.lastSurgeTs, lastSeasonal: s.lastSeasonal });
      }
    } else {
      s.pendingExit = 0;
      const deeper = level && LEVEL_RANK[level] > LEVEL_RANK[s.levelAlerted ?? "boa"];
      if (deeper) {
        const count =
          s.pendingLevel && LEVEL_RANK[s.pendingLevel.level] <= LEVEL_RANK[level]
            ? s.pendingLevel.count + 1
            : 1;
        s.pendingLevel = { level, count };
        if (count >= cfg.confirmReadings) {
          events.push({ kind: "epoca_nivel", level, from: s.levelAlerted ?? "boa" });
          s.levelAlerted = level;
          s.pendingLevel = null;
        }
      } else s.pendingLevel = null;
    }
  }

  if (cfg.surge && r.ret5 >= Math.log(1 + cfg.surgeReturn)) {
    if (s.lastSurgeTs === null || r.ts - s.lastSurgeTs >= FIVE_DAYS_MS) {
      events.push({ kind: "disparada", ret5: r.ret5 });
      s.lastSurgeTs = r.ts;
    }
  }

  const month = Number(r.date.slice(5, 7));
  if (
    cfg.seasonal &&
    r.firstBusinessDay &&
    (month === 6 || month === 12) &&
    s.lastSeasonal !== r.date.slice(0, 7)
  ) {
    events.push({ kind: "sazonal", month });
    s.lastSeasonal = r.date.slice(0, 7);
  }

  return { state: s, events };
}

/** Primeiro dia útil (seg–sex) do mês da data. */
export function isFirstBusinessDay(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  for (let day = 1; day < d.getUTCDate(); day++) {
    const w = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day)).getUTCDay();
    if (w !== 0 && w !== 6) return false;
  }
  return true;
}
