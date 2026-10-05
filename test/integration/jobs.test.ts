import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import awesome from "../fixtures/awesomeapi.json";
import cmp1000 from "../fixtures/comparison_1000.json";
import cmp300 from "../fixtures/comparison_300.json";
import cmp3000 from "../fixtures/comparison_3000.json";
import ecbCsv from "../fixtures/ecb_dfr.csv?raw";
import eurostat from "../fixtures/eurostat_hicp.json";
import focus from "../fixtures/focus.json";
import { getState, setState } from "../../src/db/state";
import { type Deps } from "../../src/deps";
import { maintenance } from "../../src/jobs/maintenance";
import { tick } from "../../src/jobs/tick";
import { fixedClock } from "../../src/lib/time";

type Route = { match: RegExp; respond: (url: string) => Response | Promise<Response> };

/** Rede simulada: cada URL conhecida devolve uma resposta; o resto responde 404. */
function network(routes: Route[]) {
  const calls: string[] = [];
  const telegram: Record<string, unknown>[] = [];
  const fetch: Deps["fetch"] = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.telegram.org/")) {
      telegram.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: telegram.length } });
    }
    const route = routes.find((r) => r.match.test(url));
    if (!route) return new Response("fora do ar", { status: 404 }); // 404 não tem retry: teste rápido
    return route.respond(url);
  };
  return { fetch, calls, telegram };
}

// Segunda 05/10/2026, 10h de Brasília (13h UTC): mercado aberto, dentro da janela de alertas
const MON_10H = Date.parse("2026-10-05T13:00:00Z");
/** Wise pública: EUR/BRL no valor pedido; USD/BRL e EUR/USD fixos. Cada par é um pedido. */
const wiseLive =
  (eurBrl: number, time = MON_10H) =>
  (url: string) => {
    const [, source, target] = /source=(\w+)&target=(\w+)/.exec(url)!;
    const value = { EURBRL: eurBrl, USDBRL: 4.99, EURUSD: 1.122 }[`${source}${target}`];
    return Response.json([{ source, target, value, time }]);
  };
const awesomeAt = (time: number) => () =>
  Response.json({
    ...awesome,
    EURBRL: { ...awesome.EURBRL, timestamp: String(Math.floor(time / 1000)) },
    USDBRL: { ...awesome.USDBRL, timestamp: String(Math.floor(time / 1000)) },
    EURUSD: { ...awesome.EURUSD, timestamp: String(Math.floor(time / 1000)) },
  });

async function rates() {
  const { results } = await env.DB.prepare("SELECT pair, ts, mid, source FROM rates ORDER BY ts, pair").all();
  return results;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rates"),
    env.DB.prepare("DELETE FROM state"),
    env.DB.prepare("DELETE FROM alerts"),
    env.DB.prepare("DELETE FROM daily_close"),
    env.DB.prepare("DELETE FROM fee_quotes"),
    env.DB.prepare("DELETE FROM macro_series"),
  ]);
});

describe("tick: coleta a cada 15 min", () => {
  it("grava os três pares da Wise no slot de 15 min", async () => {
    const net = network([
      { match: /wise\.com\/rates/, respond: wiseLive(5.5993, MON_10H - 60_000) },
      { match: /awesomeapi/, respond: awesomeAt(MON_10H) },
    ]);
    await tick(env, { clock: fixedClock(MON_10H + 7 * 60_000), fetch: net.fetch });

    const rows = await rates();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ts === MON_10H)).toBe(true);
    expect(rows.find((r) => r.pair === "EURBRL")).toMatchObject({ mid: 5.5993, source: "wise-public" });
    expect(rows.every((r) => r.source === "wise-public")).toBe(true);
    expect(net.calls.some((u) => u.includes("awesomeapi"))).toBe(false);
    expect(net.telegram).toHaveLength(0);
  });

  it("par que falhar na Wise vem da AwesomeAPI", async () => {
    const net = network([
      { match: /wise\.com\/rates.*source=EUR&target=BRL/, respond: wiseLive(5.5993, MON_10H) },
      { match: /awesomeapi/, respond: awesomeAt(MON_10H) },
    ]);
    await tick(env, { clock: fixedClock(MON_10H), fetch: net.fetch });
    const rows = await rates();
    expect(rows.map((r) => `${r.pair}:${r.source}`).sort()).toEqual([
      "EURBRL:wise-public",
      "EURUSD:awesomeapi",
      "USDBRL:awesomeapi",
    ]);
  });

  it("vigia: avisa uma vez quando a coleta para e avisa quando volta", async () => {
    const down = network([]);
    const up = network([
      { match: /wise\.com\/rates/, respond: wiseLive(5.6, MON_10H + 60 * 60_000) },
      { match: /awesomeapi/, respond: awesomeAt(MON_10H + 60 * 60_000) },
    ]);
    // última cotação boa às 10h
    await env.DB.prepare("INSERT INTO rates (pair, ts, mid, source) VALUES ('EURBRL', ?, 5.6, 'wise-public')")
      .bind(MON_10H)
      .run();

    // 10h30: falhou, mas ainda não deu 45 min
    await tick(env, { clock: fixedClock(MON_10H + 30 * 60_000), fetch: down.fetch });
    expect(down.telegram).toHaveLength(0);
    // 10h45 e 11h: avisa só uma vez
    await tick(env, { clock: fixedClock(MON_10H + 45 * 60_000), fetch: down.fetch });
    await tick(env, { clock: fixedClock(MON_10H + 60 * 60_000), fetch: down.fetch });
    expect(down.telegram).toHaveLength(1);
    expect(String(down.telegram[0]!.text)).toMatch(/Sem cotação do EUR\/BRL desde 10h00/);
    expect(await getState(env.DB, "watchdog_incident")).toBeTruthy();

    // 11h15: voltou
    await tick(env, { clock: fixedClock(MON_10H + 75 * 60_000), fetch: up.fetch });
    expect(up.telegram).toHaveLength(1);
    expect(String(up.telegram[0]!.text)).toMatch(/Coleta normalizada/);
    expect(await getState(env.DB, "watchdog_incident")).toBeNull();

    const { results } = await env.DB.prepare("SELECT kind FROM alerts").all();
    expect(results).toEqual([{ kind: "sistema" }, { kind: "sistema" }]);
  });

  it("vigia fica quieto com o mercado fechado (sábado)", async () => {
    const sat = Date.parse("2026-10-10T15:00:00Z");
    const net = network([]);
    await tick(env, { clock: fixedClock(sat), fetch: net.fetch });
    expect(net.telegram).toHaveLength(0);
  });
});

describe("manutenção das 3h", () => {
  // Terça 06/10/2026, 3h de Brasília
  const TUE_3H = Date.parse("2026-10-06T06:00:00Z");
  const fullNetwork = () =>
    network([
      { match: /sendAmount=300$/, respond: () => Response.json(cmp300) },
      { match: /sendAmount=1000$/, respond: () => Response.json(cmp1000) },
      { match: /sendAmount=3000$/, respond: () => Response.json(cmp3000) },
      {
        match: /bcdata\.sgs\.432/,
        respond: () =>
          Response.json([
            { data: "05/10/2026", valor: "13.75" },
            { data: "04/11/2026", valor: "13.75" }, // futuro: tem que sumir
          ]),
      },
      { match: /bcdata\.sgs\.433/, respond: () => Response.json([{ data: "01/08/2026", valor: "-0.32" }]) },
      { match: /olinda\.bcb/, respond: () => Response.json(focus) },
      { match: /data-api\.ecb/, respond: () => new Response(ecbCsv) },
      { match: /eurostat/, respond: () => Response.json(eurostat) },
    ]);

  it("fecha o dia útil anterior com a última cotação do dia de Brasília", async () => {
    const mon = (h: number, m = 0) =>
      Date.parse(`2026-10-05T${String(h + 3).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
    const ins = env.DB.prepare("INSERT INTO rates (pair, ts, mid, source) VALUES (?, ?, ?, 'wise-public')");
    await env.DB.batch([
      ins.bind("EURBRL", mon(9), 5.84),
      ins.bind("EURBRL", mon(20, 45), 5.6), // última de segunda em Brasília
      ins.bind("EURBRL", Date.parse("2026-10-06T03:15:00Z"), 5.7), // já é terça 0h15 em Brasília
      ins.bind("EURBRL", TUE_3H - 100 * 86_400_000, 6.0), // velha: a limpeza apaga
    ]);
    await maintenance(env, { clock: fixedClock(TUE_3H), fetch: fullNetwork().fetch });

    const close = await env.DB.prepare(
      "SELECT close, source FROM daily_close WHERE pair = 'EURBRL' AND date = '2026-10-05'",
    ).first();
    expect(close).toEqual({ close: 5.6, source: "own" });
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM rates WHERE mid = 6.0").first<{
      n: number;
    }>();
    expect(old!.n).toBe(0);
  });

  it("guarda tarifa, Selic (sem datas futuras), IPCA, Focus, BCE e inflação do euro", async () => {
    await maintenance(env, { clock: fixedClock(TUE_3H), fetch: fullNetwork().fetch });

    const fees = await env.DB.prepare("SELECT COUNT(*) AS n FROM fee_quotes").first<{ n: number }>();
    expect(fees!.n).toBe(3);
    const model = await getState<{ fixed: number; pct: number }>(env.DB, "fee_model");
    expect(model!.pct).toBeCloseTo(0.03975, 4);

    const { results } = await env.DB.prepare(
      "SELECT series, COUNT(*) AS n, MAX(date) AS last FROM macro_series GROUP BY series ORDER BY series",
    ).all<{ series: string; n: number; last: string }>();
    const by = Object.fromEntries(results.map((r) => [r.series, r]));
    expect(by.selic).toMatchObject({ n: 1, last: "2026-10-05" });
    expect(by.ipca).toMatchObject({ last: "2026-08-01" });
    expect(by.ecb_dfr!.n).toBeGreaterThan(0);
    expect(by.hicp_ea!.n).toBeGreaterThan(2);
    expect(Object.keys(by).some((k) => k.startsWith("focus_cambio:"))).toBe(true);
    expect(await getState(env.DB, "last_maintenance")).toMatchObject({ failed: [] });
  });

  it("uma fonte fora do ar não derruba as outras tarefas", async () => {
    const net = network([]); // tudo fora, menos o Telegram
    await maintenance(env, { clock: fixedClock(TUE_3H), fetch: net.fetch });
    const state = await getState<{ failed: string[] }>(env.DB, "last_maintenance");
    expect(state!.failed).toEqual(
      expect.arrayContaining(["tarifa", "selic_ipca", "focus", "bce", "inflacao_euro"]),
    );
    expect(await getState(env.DB, "hello_sent")).toBe(true);
  });

  it("avisa quando a tarifa da Wise muda mais de 10%", async () => {
    await setState(env.DB, "hello_sent", true, TUE_3H);
    await setState(env.DB, "fee_model", { fixed: 2.18, pct: 0.03 }, TUE_3H); // R$ 32 em R$ 1.000
    const net = fullNetwork();
    await maintenance(env, { clock: fixedClock(TUE_3H), fetch: net.fetch });
    expect(net.telegram).toHaveLength(1);
    expect(String(net.telegram[0]!.text)).toMatch(/tarifa da Wise mudou/);
    expect(net.telegram[0]!.disable_notification).toBe(true); // 3h da manhã: sem som
  });
});
