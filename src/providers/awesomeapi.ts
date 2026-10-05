import { type FetchFn, httpJson } from "../lib/http";
import { type Pair, type Quote, type RateProvider } from "./types";

interface AwesomeQuote {
  bid: string;
  ask: string;
  timestamp: string; // segundos
}

const URL_ALL = "https://economia.awesomeapi.com.br/json/last/EUR-BRL,USD-BRL,EUR-USD";

/** Os valores vêm como string; mid = média de bid e ask. */
export function parseAwesome(data: Record<string, AwesomeQuote>, pairs: readonly Pair[]): Quote[] {
  const out: Quote[] = [];
  for (const pair of pairs) {
    const q = data?.[pair];
    if (!q) continue;
    const bid = Number(q.bid);
    const ask = Number(q.ask);
    const ts = Number(q.timestamp) * 1000;
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
    out.push({ pair, mid: (bid + ask) / 2, bid, ask, ts, source: "awesomeapi" });
  }
  return out;
}

/** AwesomeAPI: os três pares numa chamada, sem chave (cache de ~1 min do lado deles). */
export function awesomeProvider(fetchImpl: FetchFn): RateProvider {
  return {
    name: "awesomeapi",
    pairs: ["EURBRL", "USDBRL", "EURUSD"],
    async latest(pairs) {
      const data = await httpJson<Record<string, AwesomeQuote>>(URL_ALL, { fetchImpl, timeoutMs: 8_000 });
      return parseAwesome(data, pairs);
    },
  };
}
