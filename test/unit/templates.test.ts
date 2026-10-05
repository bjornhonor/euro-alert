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
  it("boa época começou: preço, nível, Wise, comparação, pontos de atenção", () => {
    const text = renderAlert({ kind: "epoca_inicio", level: "boa" }, ctx, LEVELS);
    expect(text).toContain("🟢 <b>Boa época pra comprar euro</b>\n\n<b>R$ 5,8564</b> por euro");
    expect(text).toContain("3,3% abaixo da média de 12 meses");
    expect(text).toContain("Mais barato que 82% dos dias do último ano");
    expect(text).toContain("Nível: <b>boa</b>\nPróximos: −5% (R$ ");
    expect(text).toMatch(/💳 Na Wise: ~R\$ 6,1\d por euro, com tarifa e IOF/);
    expect(text).toContain("<b>Para comparar</b>\n• 5 anos: 0,9% acima da média");
    expect(text).toContain("• Desde 2002: 8,4% acima (já descontada a inflação)");
    expect(text).toContain("<b>Fique de olho</b>\n• Euro em tendência de queda");
    expect(text).toContain("• Eleição (2º turno) em 11 dias");
    expect(text).not.toContain("Épocas anteriores");
    expect(text).not.toMatch(/&lt;|&gt;|\n\n\n/);
  });

  it("ficou melhor: nível, desde o início e próximo nível", () => {
    const text = renderAlert({ kind: "epoca_nivel", level: "muito_boa", from: "boa" }, ctx, LEVELS);
    expect(text).toContain("🟢🟢 <b>Boa época ficou melhor</b>");
    expect(text).toContain("Nível: <b>muito boa</b>");
    expect(text).toContain("Desde o início (22/09): −0,7%");
    expect(text).toContain("Próximo nível: −8% (R$ ");
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
    expect(text).toContain("<b>Como foi</b>\n• Começou em 22/09 a R$ 5,9000");
    expect(text).toContain("• Mais baixo: R$ 5,5700 (−7,6%) em 05/10");
  });
});
