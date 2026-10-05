import { type FetchFn, httpJson } from "../lib/http";
import { type Quote, type RateProvider } from "./types";

interface WiseRate {
  rate: number;
  source: string;
  target: string;
  time: string; // "2026-10-05T12:00:00+0000"
}

/** "+0000" sem dois-pontos não é ISO estrito; normaliza antes do Date.parse. */
export function parseWiseTime(time: string): number {
  return Date.parse(time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

export function parseWiseRates(data: WiseRate[]): Quote | undefined {
  const r = Array.isArray(data) ? data[0] : undefined;
  if (!r || typeof r.rate !== "number") return undefined;
  return { pair: "EURBRL", mid: r.rate, ts: parseWiseTime(r.time), source: "wise-api" };
}

/** API oficial da Wise com token pessoal (opcional: sem token o app usa o endpoint público). */
export function wiseOfficialProvider(token: string, fetchImpl: FetchFn): RateProvider {
  return {
    name: "wise-api",
    pairs: ["EURBRL"],
    async latest(pairs) {
      if (!pairs.includes("EURBRL")) return [];
      const data = await httpJson<WiseRate[]>("https://api.wise.com/v1/rates?source=EUR&target=BRL", {
        fetchImpl,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 8_000,
      });
      const q = parseWiseRates(data);
      return q ? [q] : [];
    },
  };
}
