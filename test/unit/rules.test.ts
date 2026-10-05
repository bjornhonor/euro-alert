import { describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { DEFAULT_ALERT_CONFIG as CFG } from "../../src/alerts/config";
import { historicalEpochs } from "../../src/alerts/history";
import {
  evaluate,
  INITIAL_STATE,
  isFirstBusinessDay,
  type EpochState,
  type Reading,
  type RuleEvent,
} from "../../src/alerts/rules";

const T0 = Date.parse("2026-10-05T13:00:00Z");
const Q = 15 * 60_000;

/** Roda uma sequência de distâncias (uma leitura a cada 15 min) e devolve os eventos. */
function run(dists: number[], start: EpochState = INITIAL_STATE, extra: Partial<Reading> = {}) {
  let state = start;
  const events: { i: number; ev: RuleEvent }[] = [];
  dists.forEach((d, i) => {
    const r: Reading = {
      ts: T0 + i * Q,
      date: "2026-10-05",
      price: 6 * (1 + d),
      dist250: d,
      ret5: 0,
      firstBusinessDay: false,
      ...extra,
    };
    const out = evaluate(state, r, CFG);
    state = out.state;
    out.events.forEach((ev) => events.push({ i, ev }));
  });
  return { state, events };
}

describe("regras da boa época", () => {
  it("abre só depois de 2 leituras seguidas em −3% ou menos", () => {
    const { events, state } = run([-0.02, -0.031, -0.032]);
    expect(events).toEqual([{ i: 2, ev: { kind: "epoca_inicio", level: "boa" } }]);
    expect(state.active).toBe(true);
  });

  it("confirmação falha se a segunda leitura volta acima de −3%", () => {
    expect(run([-0.031, -0.029, -0.031]).events).toEqual([]);
  });

  it("abre já no nível em que estiver (sem avisar os níveis intermediários)", () => {
    const { events, state } = run([-0.06, -0.061]);
    expect(events).toEqual([{ i: 1, ev: { kind: "epoca_inicio", level: "muito_boa" } }]);
    expect(state.levelAlerted).toBe("muito_boa");
  });

  it("oscilar entre −3% e −1% não gera alerta (histerese)", () => {
    const { events } = run([-0.031, -0.031, -0.02, -0.015, -0.028, -0.012, -0.03]);
    expect(events.map((e) => e.ev.kind)).toEqual(["epoca_inicio"]);
  });

  it("avisa cada nível novo uma vez, com confirmação", () => {
    const { events } = run([-0.031, -0.031, -0.051, -0.052, -0.04, -0.053, -0.081, -0.082, -0.09]);
    expect(events.map((e) => [e.i, e.ev.kind, "level" in e.ev ? e.ev.level : null])).toEqual([
      [1, "epoca_inicio", "boa"],
      [3, "epoca_nivel", "muito_boa"],
      [7, "epoca_nivel", "rara"],
    ]);
  });

  it("fecha quando volta a −1% por 2 leituras, com o resumo do episódio", () => {
    const { events, state } = run([-0.031, -0.031, -0.06, -0.009, -0.005]);
    const fim = events.find((e) => e.ev.kind === "epoca_fim")!;
    expect(fim.i).toBe(4);
    expect(fim.ev).toMatchObject({ kind: "epoca_fim", minDist: -0.06, minPrice: 6 * (1 - 0.06) });
    expect(state.active).toBe(false);
  });

  it("uma leitura isolada acima de −1% não fecha", () => {
    expect(run([-0.031, -0.031, -0.009, -0.02, -0.009]).state.active).toBe(true);
  });
});

describe("disparada e sazonal", () => {
  it("disparada: +3% em 5 dias, no máximo uma vez a cada 5 dias", () => {
    const { events } = run([0, 0, 0], INITIAL_STATE, { ret5: Math.log(1.035) });
    expect(events.filter((e) => e.ev.kind === "disparada")).toHaveLength(1);
  });

  it("sazonal só no 1º dia útil de junho e dezembro, uma vez", () => {
    const dez = run([0, 0], INITIAL_STATE, { date: "2026-12-01", firstBusinessDay: true });
    expect(dez.events.map((e) => e.ev)).toEqual([{ kind: "sazonal", month: 12 }]);
    expect(run([0], INITIAL_STATE, { date: "2026-11-02", firstBusinessDay: true }).events).toEqual([]);
  });

  it("primeiro dia útil do mês", () => {
    expect(isFirstBusinessDay("2026-12-01")).toBe(true); // terça
    expect(isFirstBusinessDay("2026-11-02")).toBe(true); // segunda (1º foi domingo)
    expect(isFirstBusinessDay("2026-11-03")).toBe(false);
    expect(isFirstBusinessDay("2026-08-01")).toBe(false); // sábado
  });
});

describe("épocas históricas", () => {
  it("reproduz a pesquisa: 31 épocas no BCE desde 2002, 15 chegam a −5% e 7 a −8%", () => {
    const eps = historicalEpochs(golden.dates, golden.prices);
    expect(eps).toHaveLength(31);
    expect(eps.filter((e) => e.maxLevel !== "boa")).toHaveLength(15);
    expect(eps.filter((e) => e.maxLevel === "rara")).toHaveLength(7);
    expect(eps.at(-1)).toMatchObject({ start: "2026-09-22", end: null });
  });
});
