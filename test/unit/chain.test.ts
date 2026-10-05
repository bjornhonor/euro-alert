import { describe, expect, it } from "vitest";
import { collectQuotes } from "../../src/providers/chain";
import { type Pair, type Quote, type QuoteSource, type RateProvider } from "../../src/providers/types";

const NOW = Date.parse("2026-10-05T13:00:00Z");

function provider(
  name: QuoteSource,
  pairs: Pair[],
  values: Partial<Record<Pair, number>> | Error,
): RateProvider {
  let calls = 0;
  return {
    name,
    pairs,
    async latest(wanted) {
      calls++;
      if (values instanceof Error) throw values;
      return wanted
        .filter((p) => values[p] !== undefined)
        .map((pair): Quote => ({ pair, mid: values[pair]!, ts: NOW, source: name }));
    },
    get calls() {
      return calls;
    },
  } as RateProvider & { calls: number };
}

describe("cadeia de cotações", () => {
  it("usa a primeira fonte válida", async () => {
    const r = await collectQuotes(
      [
        provider("wise-public", ["EURBRL"], { EURBRL: 5.6 }),
        provider("awesomeapi", ["EURBRL"], { EURBRL: 5.61 }),
      ],
      ["EURBRL"],
      { EURBRL: 5.62 },
      NOW,
    );
    expect(r.quotes).toEqual([expect.objectContaining({ mid: 5.6, source: "wise-public" })]);
  });

  it("cai para a reserva quando a primeira falha", async () => {
    const r = await collectQuotes(
      [
        provider("wise-public", ["EURBRL"], new Error("timeout")),
        provider("awesomeapi", ["EURBRL"], { EURBRL: 5.61 }),
      ],
      ["EURBRL"],
      {},
      NOW,
    );
    expect(r.quotes[0]?.source).toBe("awesomeapi");
    expect(r.failures).toEqual([]);
  });

  it("chama cada fonte uma vez só por rodada", async () => {
    const awesome = provider("awesomeapi", ["EURBRL", "USDBRL", "EURUSD"], {
      EURBRL: 5.6,
      USDBRL: 4.99,
      EURUSD: 1.12,
    }) as RateProvider & { calls: number };
    const r = await collectQuotes([awesome], ["EURBRL", "USDBRL", "EURUSD"], {}, NOW);
    expect(r.quotes).toHaveLength(3);
    expect(awesome.calls).toBe(1);
  });

  it("recusa salto > 3% sem confirmação", async () => {
    const r = await collectQuotes(
      [
        provider("wise-public", ["EURBRL"], { EURBRL: 5.6 }),
        provider("awesomeapi", ["EURBRL"], new Error("fora")),
      ],
      ["EURBRL"],
      { EURBRL: 5.85 },
      NOW,
    );
    expect(r.quotes).toEqual([]);
    expect(r.failures[0]!.reason).toMatch(/salto de -4\.3%/);
  });

  it("aceita salto > 3% confirmado por outra fonte (dia seguinte à eleição)", async () => {
    const r = await collectQuotes(
      [
        provider("wise-public", ["EURBRL"], { EURBRL: 5.5993 }),
        provider("awesomeapi", ["EURBRL"], { EURBRL: 5.5982 }),
      ],
      ["EURBRL"],
      { EURBRL: 5.8404 },
      NOW,
    );
    expect(r.quotes).toEqual([expect.objectContaining({ mid: 5.5993, source: "wise-public" })]);
  });

  it("se a fonte preferida pular e a outra não, fica com a outra", async () => {
    const r = await collectQuotes(
      [
        provider("wise-public", ["EURBRL"], { EURBRL: 6.5 }),
        provider("awesomeapi", ["EURBRL"], { EURBRL: 5.84 }),
      ],
      ["EURBRL"],
      { EURBRL: 5.85 },
      NOW,
    );
    expect(r.quotes[0]?.source).toBe("awesomeapi");
  });

  it("descarta valor implausível e cotação velha", async () => {
    const stale: RateProvider = {
      name: "wise-public",
      pairs: ["EURBRL"],
      latest: async () => [{ pair: "EURBRL", mid: 5.6, ts: NOW - 7 * 3600_000, source: "wise-public" }],
    };
    const r = await collectQuotes(
      [stale, provider("awesomeapi", ["EURBRL"], { EURBRL: 0 })],
      ["EURBRL"],
      {},
      NOW,
    );
    expect(r.quotes).toEqual([]);
    expect(r.failures).toHaveLength(1);
  });

  it("par de fonte única aceita o salto (com aviso)", async () => {
    const r = await collectQuotes(
      [provider("awesomeapi", ["USDBRL"], { USDBRL: 4.99 })],
      ["USDBRL"],
      { USDBRL: 5.22 },
      NOW,
    );
    expect(r.quotes[0]?.mid).toBe(4.99);
  });
});
