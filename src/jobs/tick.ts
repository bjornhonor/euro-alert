import { insertRates, lastRates } from "../db/rates";
import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { errorFields, log } from "../lib/log";
import { brt, floorTo15Min, isFxMarketOpen } from "../lib/time";
import { awesomeProvider } from "../providers/awesomeapi";
import { collectQuotes } from "../providers/chain";
import { type Pair, type RateProvider } from "../providers/types";
import { wiseOfficialProvider } from "../providers/wise-official";
import { wisePublicProvider } from "../providers/wise-public";
import { escapeHtml } from "../telegram/api";
import { sendSystemAlert } from "../telegram/notify";
import { computeAndStoreSignal } from "./signals";

export const PAIRS: readonly Pair[] = ["EURBRL", "USDBRL", "EURUSD"];
/** Sem EUR/BRL novo há esse tempo, com o mercado aberto, vira alerta de sistema. */
export const STALE_AFTER_MS = 45 * 60 * 1000;

interface Incident {
  since: number; // última cotação boa antes da falha
  alertedAt: number;
  reason: string;
}

/**
 * Ordem de preferência: Wise com token (só EUR/BRL), Wise pública (os três pares) e AwesomeAPI
 * de reserva (em 05/10/2026 ela falhou nos pedidos vindos da Cloudflare; funciona local).
 */
export function buildProviders(env: Env, deps: Deps): RateProvider[] {
  const providers: RateProvider[] = [];
  if (env.WISE_API_TOKEN) providers.push(wiseOfficialProvider(env.WISE_API_TOKEN, deps.fetch));
  providers.push(wisePublicProvider(deps.fetch), awesomeProvider(deps.fetch));
  return providers;
}

const hhmm = (ms: number) => {
  const p = brt(ms);
  return `${String(p.hour).padStart(2, "0")}h${String(p.minute).padStart(2, "0")}`;
};

/** A cada 15 min: coleta as cotações, calcula os indicadores e vigia a coleta. Alertas entram na Etapa 4. */
export async function tick(env: Env, deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const last = await lastRates(env.DB);
  const lastMid = Object.fromEntries(Object.values(last).map((r) => [r.pair, r.mid]));

  const { quotes, failures } = await collectQuotes(buildProviders(env, deps), PAIRS, lastMid, now);
  await insertRates(env.DB, floorTo15Min(now), quotes);
  await setState(env.DB, "last_tick", now, now);
  for (const f of failures) log("warn", "par sem cotação", f);

  const eur = quotes.find((q) => q.pair === "EURBRL");
  const incident = await getState<Incident | null>(env.DB, "watchdog_incident");

  if (eur) {
    log("info", "cotação", { mid: eur.mid, source: eur.source });
    try {
      const signal = await computeAndStoreSignal(env, now, quotes);
      if (signal?.real) {
        log("info", "sinal", {
          dist250: signal.epoch.dist250,
          level: signal.epoch.level,
          dist1260: signal.epoch.dist1260,
          realDist: signal.real.dist,
          score: signal.score.score,
        });
      } else log("warn", "sinal: histórico insuficiente (backfill ou cálculo da história pendente)");
    } catch (err) {
      log("error", "sinal: falhou", errorFields(err)); // não impede o vigia nem a coleta
    }
    if (incident) {
      await sendSystemAlert(
        env,
        deps,
        `✅ Coleta normalizada: EUR/BRL ${eur.mid.toFixed(4)} (${eur.source}). Estava parada desde ${hhmm(incident.since)}.`,
      );
      await setState(env.DB, "watchdog_incident", null, now);
    }
    return;
  }

  // Sem EUR/BRL nesta rodada
  const lastTs = last.EURBRL?.ts;
  const stale = lastTs === undefined || now - lastTs >= STALE_AFTER_MS;
  if (incident || !stale || !isFxMarketOpen(now)) return;
  const reason = failures.find((f) => f.pair === "EURBRL")?.reason ?? "desconhecido";
  await sendSystemAlert(
    env,
    deps,
    `⚠️ Sem cotação do EUR/BRL desde ${lastTs ? hhmm(lastTs) : "o início"}. Motivo: ${escapeHtml(reason)}. ` +
      "Aviso de novo quando voltar.",
  );
  await setState(env.DB, "watchdog_incident", { since: lastTs ?? now, alertedAt: now, reason }, now);
}
