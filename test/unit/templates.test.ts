import { describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { aboveBelow, num, pct } from "../../src/alerts/format";
import { LEVELS } from "../../src/engine/epoch";
import { computeSignal } from "../../src/engine/signal";
import { renderAlert } from "../../src/telegram/templates";

const signal = computeSignal({
  closes: golden.prices.slice(0, -1),
  live: golden.prices.at(-1)!,
  real: { mean: 5.4013, dist: 0.0843, cheaperThan: 0.3, days: 6331 },
  seasonal: { month: 9, mean: -0.2, n: 24 },
})!;
const ctx = {
  signal,
  today: "2026-10-14",
  feeModel: { fixed: 2.18, pct: 0.03975 },
  score: { epochs: 6, measured: 5, vsNext3m: -0.021, hitRate: 0.8, furtherDrop: -0.014 },
  epochStart: { date: "2026-09-22", price: 5.9 },
};

describe("formatação", () => {
  it("usa vírgula e o sinal de menos tipográfico", () => {
    expect(num(5.8564, 4)).toBe("5,8564");
    expect(pct(-0.0327)).toBe("−3,3%");
    expect(pct(0.009, 1, true)).toBe("+0,9%");
    expect(aboveBelow(-0.0327)).toBe("3,3% abaixo");
  });
});

describe("modelos de mensagem (Apêndice C)", () => {
  it("boa época começou: três horizontes, nível, contexto, placar e custo", () => {
    const text = renderAlert({ kind: "epoca_inicio", level: "boa" }, ctx, LEVELS);
    expect(text).toContain("🟢 <b>Boa época</b> · EUR/BRL 5,8564");
    expect(text).toContain("12 meses: 3,3% abaixo da média");
    expect(text).toContain("mais barato que 82% dos dias");
    expect(text).toContain("5 anos: 0,9% acima da média");
    expect(text).toContain("História (desde 2002, corrigida pela inflação): 8,4% acima da média (5,4013)");
    expect(text).toContain("Nível: boa · próximos: −5% (");
    expect(text).toContain("• Média de 12 meses caindo");
    expect(text).toContain("Eleição (2º turno) em 11 dias");
    expect(text).toContain("Placar (5 épocas nos últimos 5 anos)");
    expect(text).toMatch(/Custo na Wise: ~R\$ 6,1\d\/€ \(tarifa \+ IOF, para R\$ 1\.000\)/);
    expect(text).not.toMatch(/&lt;|&gt;/);
  });

  it("ficou melhor: nível, desde o início e próximo nível", () => {
    const text = renderAlert({ kind: "epoca_nivel", level: "muito_boa", from: "boa" }, ctx, LEVELS);
    expect(text).toContain("🟢🟢 <b>Boa época ficou melhor</b>");
    expect(text).toContain("nível: muito boa");
    expect(text).toContain("Desde o início (22/09): −0,7%");
    expect(text).toContain("Nível seguinte: −8%");
  });

  it("terminou: resumo do episódio", () => {
    const text = renderAlert(
      {
        kind: "epoca_fim",
        startTs: Date.parse("2026-09-22T21:00:00Z"),
        entryPrice: 5.9,
        minPrice: 5.57,
        minDist: -0.076,
        minTs: Date.parse("2026-10-05T14:30:00Z"),
        levelReached: "muito_boa",
      },
      ctx,
      LEVELS,
    );
    expect(text).toContain("⚪ <b>Boa época terminou</b>");
    expect(text).toContain("ponto mais baixo 5,5700 (−7,6%) em 05/10");
  });
});
