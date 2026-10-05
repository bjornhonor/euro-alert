import { describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { buildAnalystInput, commentBlock, validateAnalysis } from "../../src/ai/alert-analyst";
import { numbersInText, unknownNumbers } from "../../src/ai/numbers";
import { computeSignal } from "../../src/engine/signal";

const signal = computeSignal({
  closes: golden.prices.slice(0, -1),
  live: golden.prices.at(-1)!,
  real: { mean: 5.4013, dist: 0.0843, cheaperThan: 0.3, days: 6331 },
})!;
const input = buildAnalystInput({ kind: "epoca_inicio", level: "boa", signal, today: "2026-09-23" });

const good = {
  leitura: "tendencia_de_queda",
  confianca: "media",
  motivos: ["A média de 12 meses está caindo", "O preço está 3,3% abaixo da média de 12 meses"],
  riscos: ["Pode subir de novo perto da eleição"],
  o_que_mudaria: "A média de 12 meses voltar a subir",
  texto_curto:
    "O euro está 3,3% abaixo da média de 12 meses, mas a média vem caindo: parece tendência de queda.",
};

describe("entrada da IA", () => {
  it("só números de mercado, com os três horizontes e os eventos", () => {
    expect(input.alerta).toEqual({ tipo: "epoca_inicio", nivel: "boa", preco: 5.8564 });
    expect(input.horizontes["12m"].distancia).toBeCloseTo(-0.0327, 4);
    expect(input.serie_60d).toHaveLength(60);
    expect(input.eventos_14d).toEqual([]); // nada nos 14 dias depois de 23/09
    const later = buildAnalystInput({ kind: "epoca_inicio", level: "boa", signal, today: "2026-10-14" });
    expect(later.eventos_14d).toEqual([{ data: "2026-10-25", titulo: "Eleição (2º turno)", em_dias: 11 }]);
  });
});

describe("checagem de números", () => {
  it("lê números em português", () => {
    expect(numbersInText("R$ 5,8564 e 3,3% em 12 meses")).toEqual([5.8564, 3.3, 12]);
  });

  it("aceita porcentagem de fração, preço arredondado e inteiros pequenos", () => {
    expect(unknownNumbers(["3,3% abaixo", "R$ 5,86", "em 12 meses"], input)).toEqual([]);
  });

  it("acusa número inventado", () => {
    expect(unknownNumbers(["deve chegar a 4,95"], input)).toEqual([4.95]);
  });
});

describe("validação da resposta", () => {
  it("aceita a resposta boa", () => {
    expect(validateAnalysis(good, input).leitura).toBe("tendencia_de_queda");
  });

  it("recusa leitura fora da lista, texto longo demais e número inventado", () => {
    expect(() => validateAnalysis({ ...good, leitura: "compre" }, input)).toThrow();
    expect(() => validateAnalysis({ ...good, texto_curto: "a".repeat(281) }, input)).toThrow();
    expect(() =>
      validateAnalysis(
        { ...good, texto_curto: "O euro vai a 4,95 até dezembro, segundo a tendência." },
        input,
      ),
    ).toThrow(/números que não estão na entrada: 4.95/);
  });

  it("o texto da IA é escapado no HTML do Telegram", () => {
    const block = commentBlock(
      validateAnalysis({ ...good, texto_curto: "Euro <b>barato</b> & em tendência de queda agora." }, input),
    );
    expect(block).toContain("&lt;b&gt;barato&lt;/b&gt; &amp;");
    expect(block).toContain("🤖 <b>Leitura da IA:</b> tendência de queda (confiança média)");
  });
});
