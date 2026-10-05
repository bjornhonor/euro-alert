import { describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { extractJson } from "../../src/ai/llm";
import { buildNewsContext, renderNews, validateNews } from "../../src/ai/news-analyst";
import { computeSignal } from "../../src/engine/signal";

export const NEWS = {
  resumo: "O euro caiu porque o resultado da eleição fortaleceu o real【1†L18-L27】.",
  o_que_aconteceu: ["1º turno da eleição → entrada de capital estrangeiro, real mais forte"],
  tendencia_7d: "baixa",
  tendencia_explicacao: "O real deve seguir forte até o 2º turno.",
  o_que_pode_mudar: ["BCE mais duro"],
  fontes: [{ titulo: "Euro derrete após o 1º turno", url: "https://www.estadao.com.br/a?b=1&c=2" }],
};

describe("análise de notícias", () => {
  it("o contexto leva só o movimento do preço e o calendário", () => {
    const signal = computeSignal({ closes: golden.prices.slice(0, -1), live: golden.prices.at(-1)! })!;
    const ctx = buildNewsContext(signal, "2026-10-20", 10);
    expect(ctx).toContain("EUR/BRL agora: R$ 5,8564.");
    expect(ctx).toMatch(/Variação em 5 dias úteis: [+−]\d+,\d%/);
    expect(ctx).toContain("Evento no calendário: Eleição (2º turno) em 25/10.");
  });

  it("acha o JSON mesmo com texto em volta", () => {
    expect(extractJson('Aqui está:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson("sem json")).toThrow();
  });

  it("valida, tira as marcas de citação e recusa tendência fora da lista ou fonte sem link", () => {
    const a = validateNews(NEWS);
    expect(a.resumo).toBe("O euro caiu porque o resultado da eleição fortaleceu o real.");
    expect(() => validateNews({ ...NEWS, tendencia_7d: "compre" })).toThrow();
    expect(() =>
      validateNews({ ...NEWS, fontes: [{ titulo: "x y z", url: "javascript:alert(1)" }] }),
    ).toThrow();
    expect(() => validateNews({ ...NEWS, fontes: [] })).toThrow();
  });

  it("mensagem com tendência, fontes como link e texto escapado", () => {
    const text = renderNews(
      validateNews({ ...NEWS, resumo: "Euro <caiu> & real subiu forte depois da eleição." }),
      {
        date: "2026-10-05",
        hour: 12,
        minute: 5,
      },
    );
    expect(text).toContain("🌍 <b>Por que o euro está se mexendo</b> · 05/10 12h05");
    expect(text).toContain("Euro &lt;caiu&gt; &amp; real");
    expect(text).toContain("<b>Próximos 7 dias:</b> 📉 euro tende a <b>cair</b> frente ao real");
    expect(text).toContain(
      '• <a href="https://www.estadao.com.br/a?b=1&amp;c=2">Euro derrete após o 1º turno</a>',
    );
  });
});
