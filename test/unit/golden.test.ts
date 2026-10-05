import { describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { epochAt } from "../../src/engine/epoch";
import { kByMonth, realContext } from "../../src/engine/real-rate";
import { scoreAt } from "../../src/engine/score";
import { seasonalIndex } from "../../src/engine/seasonality";

/**
 * Indicadores em TypeScript contra a referência em Python (research/golden.py, pandas),
 * calculados sobre a série real do BCE desde 2002. Tolerância relativa de 1e-9.
 */
const { dates, prices, ipca, hicp, points } = golden;

function close(actual: number, expected: number | null, label: string) {
  if (expected === null) return expect(Number.isNaN(actual), `${label} deveria ser NaN`).toBe(true);
  const tol = 1e-9 * Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

describe.each(points)("referência Python em $date", (pt) => {
  it("score de curto prazo e seus componentes", () => {
    const s = scoreAt(prices, pt.i);
    close(s.z20, pt.z20, "z20");
    close(s.pct90, pt.pct90, "pct90");
    close(s.rsi, pt.rsi, "rsi");
    close(s.sd60, pt.sd60, "sd60");
    close(s.ret5, pt.ret5, "ret5");
    close(s.score, pt.score, "score");
  });

  it("boa época: distâncias, percentis e tendência", () => {
    const e = epochAt(prices, pt.i);
    expect(e.price).toBe(pt.price);
    close(e.dist250, pt.dist250, "dist250");
    close(e.pct250, pt.pct250, "pct250");
    close(e.dist1260, pt.dist1260, "dist1260");
    close(e.pct1260, pt.pct1260, "pct1260");
    close(e.slope250, pt.slope250, "slope250");
    expect(e.aboveSma20).toBe(pt.aboveSma20);
    expect(e.aboveSma50).toBe(pt.aboveSma50);
  });

  it("câmbio real contra a história", () => {
    const k = kByMonth(ipca, hicp, dates.at(-1)!.slice(0, 7));
    const deflated = prices.slice(0, pt.i).map((p, j) => p / k.get(dates[j]!.slice(0, 7))!);
    const r = realContext(deflated, pt.price, k.get(pt.date.slice(0, 7))!);
    close(r.mean, pt.real.mean, "média real");
    close(r.dist, pt.real.dist, "distância real");
    close(r.cheaperThan, pt.real.cheaperThan, "mais barato que");
    expect(r.days).toBe(pt.real.days);
  });
});

describe("sazonalidade", () => {
  it("índice por mês igual ao da pesquisa", () => {
    const byMonth = new Map<string, number[]>();
    dates.forEach((d, j) => {
      const m = d.slice(0, 7);
      byMonth.set(m, [...(byMonth.get(m) ?? []), prices[j]!]);
    });
    const monthly = [...byMonth].map(([month, xs]) => ({
      month,
      mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    }));
    const idx = seasonalIndex(monthly);
    for (const [cal, ref] of Object.entries(golden.seasonality)) {
      close(idx[Number(cal)]!.mean, ref.mean, `mês ${cal}`);
      expect(idx[Number(cal)]!.n).toBe(ref.n);
    }
  });
});

describe("sem olhar o futuro", () => {
  it("acrescentar dias depois não muda os indicadores de um dia passado", () => {
    const i = points[0]!.i;
    const cut = prices.slice(0, i + 1);
    expect(epochAt(cut)).toEqual(epochAt(prices, i));
    expect(scoreAt(cut)).toEqual(scoreAt(prices, i));
  });
});
