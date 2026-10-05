import { describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { buildChartConfig, parseRange } from "../../src/telegram/chart";
import { parseDuration } from "../../src/telegram/commands";
import { renderEpochs, renderScore } from "../../src/telegram/views";
import { isoWeek } from "../../src/jobs/weekly";

describe("argumentos dos comandos", () => {
  it("/pausar aceita horas e dias, padrão 24h, até 30 dias", () => {
    expect(parseDuration(undefined)).toBe(86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3600_000);
    expect(parseDuration("3d")).toBe(3 * 86_400_000);
    expect(parseDuration("2")).toBe(2 * 86_400_000);
    expect(parseDuration("1,5d")).toBe(1.5 * 86_400_000);
    expect(parseDuration("40d")).toBeUndefined();
    expect(parseDuration("amanhã")).toBeUndefined();
  });

  it("/grafico aceita 90d, 1a e 5a (padrão 1a)", () => {
    expect(parseRange(undefined)).toBe("1a");
    expect(parseRange("90d")).toBe("90d");
    expect(parseRange("5A")).toBe("5a");
    expect(parseRange("10a")).toBeUndefined();
  });

  it("semana ISO", () => {
    expect(isoWeek("2026-10-09")).toBe(41);
    expect(isoWeek("2027-01-01")).toBe(53);
  });
});

describe("gráfico", () => {
  const dates = golden.dates;
  const prices = golden.prices;
  type Cfg = {
    data: { labels: string[]; datasets: { label: string; data: number[] }[] };
    options: { annotation: { annotations: { xMin: string; xMax: string }[] } };
  };

  it("1 ano: 250 pontos, média de 12 meses e faixas de −3%, −5% e −8%", () => {
    const cfg = buildChartConfig({ dates, prices, range: "1a", epochs: [] }) as Cfg;
    expect(cfg.data.labels).toHaveLength(250);
    expect(cfg.data.labels.at(-1)).toBe("23/09/26");
    expect(cfg.data.datasets.map((d) => d.label)).toEqual(["EUR/BRL", "Média 12 meses", "−3%", "−5%", "−8%"]);
    const [price, sma, b3] = cfg.data.datasets;
    expect(price!.data.at(-1)).toBe(5.8564);
    expect(b3!.data.at(-1)).toBeCloseTo(sma!.data.at(-1)! * 0.97, 3);
  });

  it("5 anos: um ponto por semana, sempre com o último dia", () => {
    const cfg = buildChartConfig({ dates, prices, range: "5a", epochs: [] }) as Cfg;
    expect(cfg.data.labels.length).toBeLessThan(260);
    expect(cfg.data.labels.at(-1)).toBe("23/09/26");
  });

  it("sombreia as épocas dentro do período (a aberta vai até o fim)", () => {
    const cfg = buildChartConfig({
      dates,
      prices,
      range: "90d",
      epochs: [
        { start: "2010-01-04", end: "2010-03-01" }, // fora do período
        { start: "2026-09-22", end: null },
      ],
    }) as Cfg;
    expect(cfg.options.annotation.annotations).toEqual([
      expect.objectContaining({ xMin: "22/09/26", xMax: "23/09/26" }),
    ]);
  });
});

describe("textos", () => {
  it("/epoca fora de boa época mostra há quanto tempo terminou a última", () => {
    const text = renderEpochs({
      today: "2026-10-20",
      price: 6.0,
      dist250: -0.01,
      epochs: [
        {
          start: "2026-10-05",
          end: "2026-10-15",
          entryPrice: 5.58,
          minPrice: 5.5,
          minDist: -0.09,
          minDate: "2026-10-07",
          maxLevel: "rara",
        },
      ],
    });
    expect(text).toContain("⚪ <b>Fora de boa época</b>");
    expect(text).toContain("A última terminou em 15/10 (há 5 dias)");
    expect(text).toContain("05/10/26 a 15/10 · rara · mínimo −9,0%");
  });

  it("/placar mostra os três períodos", () => {
    const s = { epochs: 3, measured: 2, vsNext3m: -0.02, hitRate: 0.5, furtherDrop: -0.03 };
    const text = renderScore({ year: s, fiveYears: s, all: { ...s, measured: 0 } });
    expect(text).toContain("<b>Último ano (3 épocas)</b>");
    expect(text).toContain("Começo vs média dos 3 meses seguintes: −2,0% em média");
    expect(text).toContain("nenhuma com os 3 meses seguintes completos ainda");
  });
});
