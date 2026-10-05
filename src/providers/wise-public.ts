import { BROWSER_USER_AGENT, type FetchFn, httpJson } from "../lib/http";
import { type Pair, type Quote, type RateProvider } from "./types";

export interface WisePoint {
  source: string;
  target: string;
  value: number;
  time: number;
}

const BASE = "https://wise.com/rates/history+live";

/** Só algumas combinações funcionam: 1 dia por hora (ao vivo) e 5 anos por dia (histórico). */
export function wiseHistoryUrl(source: string, target: string, preset: "live" | "daily5y"): string {
  const q = preset === "live" ? "length=1&resolution=hourly&unit=day" : "length=5&resolution=daily&unit=year";
  return `${BASE}?source=${source}&target=${target}&${q}`;
}

export async function fetchWiseHistory(
  fetchImpl: FetchFn,
  source: string,
  target: string,
  preset: "live" | "daily5y",
): Promise<WisePoint[]> {
  const data = await httpJson<WisePoint[]>(wiseHistoryUrl(source, target, preset), {
    fetchImpl,
    userAgent: BROWSER_USER_AGENT, // recusa user-agent de robô
    timeoutMs: 8_000,
  });
  if (!Array.isArray(data)) throw new Error("wise-public: resposta não é uma lista");
  return data;
}

/** O último ponto da série `history+live` é o preço ao vivo. */
export function parseWiseLive(points: WisePoint[], pair: Pair): Quote | undefined {
  const last = points.at(-1);
  if (!last || typeof last.value !== "number") return undefined;
  return { pair, mid: last.value, ts: last.time, source: "wise-public" };
}

/**
 * Endpoint público da Wise (sem token), um pedido por par, em paralelo. Instável: o retry
 * fica no http(); um par que falhar não derruba os outros. Só lança erro se todos falharem.
 */
export function wisePublicProvider(fetchImpl: FetchFn): RateProvider {
  return {
    name: "wise-public",
    pairs: ["EURBRL", "USDBRL", "EURUSD"],
    async latest(pairs) {
      const settled = await Promise.allSettled(
        pairs.map(async (pair) =>
          parseWiseLive(await fetchWiseHistory(fetchImpl, pair.slice(0, 3), pair.slice(3), "live"), pair),
        ),
      );
      const quotes = settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
      const firstError = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (quotes.length === 0 && firstError) throw firstError.reason;
      return quotes;
    },
  };
}
