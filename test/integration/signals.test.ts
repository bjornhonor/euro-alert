import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { getState } from "../../src/db/state";
import { computeAndStoreSignal, refreshHistory } from "../../src/jobs/signals";

/**
 * Caminho completo no banco: carrega a série real (golden), calcula a história (deflacionados,
 * K do mês, sazonalidade) e grava o sinal com o preço "ao vivo" do último dia. Tem de bater com
 * a referência em Python do mesmo dia.
 */
const { dates, prices, ipca, hicp } = golden;
const last = golden.points.find((p) => p.i === dates.length - 1)!;
// 23/09/2026 (quarta), 15h de Brasília
const NOW = Date.parse(`${last.date}T18:00:00Z`);

beforeAll(async () => {
  const ins = env.DB.prepare(
    "INSERT INTO daily_close (pair, date, close, source) VALUES ('EURBRL', ?, ?, 'ecb')",
  );
  const rows = dates.slice(0, -1).map((d, j) => ins.bind(d, prices[j]!));
  for (let i = 0; i < rows.length; i += 500) await env.DB.batch(rows.slice(i, i + 500));
  const macro = env.DB.prepare("INSERT INTO macro_series (series, date, value) VALUES (?, ?, ?)");
  await env.DB.batch([
    ...ipca.map((o) => macro.bind("ipca", o.date, o.value)),
    ...hicp.map((o) => macro.bind("hicp_ea", o.date, o.value)),
  ]);
});

describe("indicadores no banco", () => {
  it("sem a história calculada, não grava sinal", async () => {
    const s = await computeAndStoreSignal(env, NOW, [
      { pair: "EURBRL", mid: last.price, ts: NOW, source: "wise-public" },
    ]);
    expect(s?.real).toBeUndefined();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM signals").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("calcula a história e grava o sinal igual à referência Python", async () => {
    await refreshHistory(env, NOW);
    expect(await getState(env.DB, "real_k")).toMatchObject({ month: "2026-09" });
    const seasonal = await getState<Record<string, { mean: number }>>(env.DB, "seasonality");
    expect(seasonal!["12"]!.mean).toBeGreaterThan(0); // dezembro: euro mais caro

    const s = (await computeAndStoreSignal(env, NOW, [
      { pair: "EURBRL", mid: last.price, ts: NOW, source: "wise-public" },
    ]))!;
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
    near(s.epoch.dist250, last.dist250);
    near(s.epoch.pct250, last.pct250!);
    near(s.epoch.dist1260, last.dist1260!);
    near(s.epoch.pct1260, last.pct1260!);
    near(s.score.score, last.score);
    near(s.real!.dist, last.real.dist);
    near(s.real!.cheaperThan, last.real.cheaperThan);
    expect(s.epoch.level).toBe("boa"); // −3,3% da média de 12 meses

    const row = await env.DB.prepare("SELECT price, dist250, level, extra FROM signals").first<{
      price: number;
      dist250: number;
      level: string;
      extra: string;
    }>();
    expect(row).toMatchObject({ price: last.price, level: "boa" });
    const extra = JSON.parse(row!.extra);
    expect(extra.projection).toHaveLength(2);
    expect(extra.seasonal.month).toBe(9);
  });
});
