import { errorFields, log } from "../lib/log";
import { isPlausible, type Pair, type Quote, type RateProvider } from "./types";

/** Variação acima disso contra a última cotação salva só vale se outra fonte confirmar. */
export const MAX_JUMP = 0.03;
/** Duas fontes "concordam" se a diferença for no máximo isso. */
export const CONFIRM_TOLERANCE = 0.005;
/** Cotação mais velha que isso na fonte é ignorada (fonte travada). */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface ChainResult {
  quotes: Quote[];
  failures: { pair: Pair; reason: string }[];
}

const agree = (a: number, b: number) => Math.abs(a / b - 1) <= CONFIRM_TOLERANCE;

/**
 * Pega cada par na primeira fonte que der uma cotação válida, na ordem das fontes.
 * Válida = plausível, recente e sem salto > 3% contra a última salva. Um salto só é aceito
 * se outra fonte confirmar (ex.: o euro caiu 4,7% no dia seguinte à eleição de 2026).
 * Pares com uma fonte só (USD/BRL, EUR/USD) aceitam o salto com aviso no log.
 */
export async function collectQuotes(
  providers: readonly RateProvider[],
  pairs: readonly Pair[],
  lastMid: Partial<Record<Pair, number>>,
  now: number,
): Promise<ChainResult> {
  const cache = new Map<RateProvider, Promise<Quote[]>>();
  const fetchOnce = (p: RateProvider) => {
    let pending = cache.get(p);
    if (!pending) {
      const wanted = pairs.filter((pair) => p.pairs.includes(pair));
      pending = p.latest(wanted).catch((err) => {
        log("warn", "fonte de cotação falhou", { source: p.name, ...errorFields(err) });
        return [];
      });
      cache.set(p, pending);
    }
    return pending;
  };

  const result: ChainResult = { quotes: [], failures: [] };
  for (const pair of pairs) {
    const sources = providers.filter((p) => p.pairs.includes(pair));
    const last = lastMid[pair];
    let suspicious: Quote | undefined;
    let accepted: Quote | undefined;
    let reason = "nenhuma fonte respondeu";

    for (const provider of sources) {
      const q = (await fetchOnce(provider)).find((x) => x.pair === pair);
      if (!q) continue;
      if (!isPlausible(q)) {
        reason = `valor implausível em ${q.source}: ${q.mid}`;
        continue;
      }
      if (now - q.ts > MAX_AGE_MS) {
        reason = `cotação velha em ${q.source}`;
        continue;
      }
      const jumped = last !== undefined && Math.abs(q.mid / last - 1) > MAX_JUMP;
      if (!jumped) {
        accepted = q;
        break;
      }
      if (suspicious && agree(suspicious.mid, q.mid)) {
        accepted = suspicious; // a fonte preferida, agora confirmada
        break;
      }
      suspicious ??= q;
      reason = `salto de ${(100 * (q.mid / last - 1)).toFixed(1)}% sem confirmação`;
    }

    if (!accepted && suspicious && sources.length === 1) {
      log("warn", "salto aceito sem confirmação (fonte única)", { pair, mid: suspicious.mid, last });
      accepted = suspicious;
    }
    if (accepted) result.quotes.push(accepted);
    else result.failures.push({ pair, reason });
  }
  return result;
}
