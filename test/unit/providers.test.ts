import { describe, expect, it } from "vitest";
import awesome from "../fixtures/awesomeapi.json";
import cmp1000 from "../fixtures/comparison_1000.json";
import cmp300 from "../fixtures/comparison_300.json";
import cmp3000 from "../fixtures/comparison_3000.json";
import ecbCsv from "../fixtures/ecb_dfr.csv?raw";
import eurostat from "../fixtures/eurostat_hicp.json";
import focus from "../fixtures/focus.json";
import sgsFuture from "../fixtures/sgs_432.json";
import wiseLive from "../fixtures/wise_live.json";
import { parseAwesome } from "../../src/providers/awesomeapi";
import { brDateToIso, parseFocus, parseSgs } from "../../src/providers/bcb";
import { parseEcbCsv, parseEurostat } from "../../src/providers/euro-area";
import { effectiveBrlPerEur, feeFor, fitFeeModel, parseComparison } from "../../src/providers/wise-fees";
import { parseWiseRates, parseWiseTime } from "../../src/providers/wise-official";
import { parseWiseLive } from "../../src/providers/wise-public";

describe("Wise pública", () => {
  it("usa o último ponto como preço ao vivo", () => {
    expect(parseWiseLive(wiseLive, "EURBRL")).toEqual({
      pair: "EURBRL",
      mid: 5.88601,
      ts: 1790188522023,
      source: "wise-public",
    });
  });

  it("lista vazia não vira cotação", () => {
    expect(parseWiseLive([], "EURBRL")).toBeUndefined();
  });
});

describe("Wise oficial", () => {
  it("entende o fuso '+0000' sem dois-pontos", () => {
    expect(parseWiseTime("2026-10-05T12:00:00+0000")).toBe(Date.parse("2026-10-05T12:00:00Z"));
  });

  it("lê o primeiro item da lista", () => {
    const q = parseWiseRates([{ rate: 5.6, source: "EUR", target: "BRL", time: "2026-10-05T12:00:00+0000" }]);
    expect(q).toMatchObject({ pair: "EURBRL", mid: 5.6, source: "wise-api" });
  });
});

describe("AwesomeAPI", () => {
  it("converte as strings e usa a média de compra e venda", () => {
    const quotes = parseAwesome(awesome, ["EURBRL", "USDBRL", "EURUSD"]);
    expect(quotes).toHaveLength(3);
    const eur = quotes.find((q) => q.pair === "EURBRL")!;
    expect(eur.mid).toBeCloseTo((5.885 + 5.887) / 2, 6);
    expect(eur.ts).toBe(1790188451000);
  });

  it("devolve só os pares pedidos", () => {
    expect(parseAwesome(awesome, ["EURBRL"]).map((q) => q.pair)).toEqual(["EURBRL"]);
  });
});

describe("custo da Wise", () => {
  const quotes = [
    parseComparison(cmp300, 300)!,
    parseComparison(cmp1000, 1000)!,
    parseComparison(cmp3000, 3000)!,
  ];

  it("lê só a cotação da Wise entre os provedores", () => {
    expect(quotes[1]).toEqual({ amountBrl: 1000, feeBrl: 41.93, rate: 0.169958, receivedEur: 162.83 });
  });

  it("ajusta a reta tarifa = fixo + % do valor (~R$ 2,18 + 3,975%)", () => {
    const model = fitFeeModel(quotes)!;
    expect(model.fixed).toBeCloseTo(2.18, 1);
    expect(model.pct).toBeCloseTo(0.03975, 4);
    expect(feeFor(model, 1000)).toBeCloseTo(41.93, 1);
  });

  it("custo efetivo por euro bate com o que a Wise entrega", () => {
    const model = fitFeeModel(quotes)!;
    const mid = 1 / 0.169958;
    expect(effectiveBrlPerEur(model, mid)).toBeCloseTo(1000 / 162.83, 2);
  });

  it("precisa de dois valores diferentes", () => {
    expect(fitFeeModel([quotes[0]!])).toBeUndefined();
  });
});

describe("Banco Central", () => {
  it("converte dd/MM/aaaa", () => {
    expect(brDateToIso("23/09/2026")).toBe("2026-09-23");
  });

  it("descarta as datas futuras que a série da Selic traz", () => {
    expect(parseSgs(sgsFuture, "2026-10-05")).toEqual([]);
    const mixed = [
      { data: "02/10/2026", valor: "13.75" },
      { data: "05/10/2026", valor: "13.75" },
      { data: "06/10/2026", valor: "13.75" },
    ];
    expect(parseSgs(mixed, "2026-10-05").map((o) => o.date)).toEqual(["2026-10-02", "2026-10-05"]);
  });

  it("lê a mediana do Focus por ano", () => {
    const rows = parseFocus(focus);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ year: expect.stringMatching(/^\d{4}$/), median: expect.any(Number) });
  });
});

describe("zona do euro", () => {
  it("lê a taxa de depósito do CSV do BCE", () => {
    const obs = parseEcbCsv(ecbCsv);
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.at(-1)!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(obs.at(-1)!.value).toBeGreaterThan(0);
  });

  it("lê o índice de inflação da Eurostat em ordem de mês", () => {
    const obs = parseEurostat(eurostat);
    expect(obs.length).toBeGreaterThan(2);
    expect(obs[0]!.date).toBe("2026-06-01");
    expect(obs.map((o) => o.date)).toEqual([...obs.map((o) => o.date)].sort());
  });
});
