import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { processAlerts } from "../../src/alerts/run";
import { getState, setState } from "../../src/db/state";
import { type Deps } from "../../src/deps";
import { computeSignal } from "../../src/engine/signal";
import { summary } from "../../src/jobs/summary";
import { fixedClock } from "../../src/lib/time";
import { handleWebhook, SECRET_HEADER } from "../../src/telegram/webhook";

// Sinal real de 23/09/2026: 3,3% abaixo da média de 12 meses (nível boa)
const signal = computeSignal({
  closes: golden.prices.slice(0, -1),
  live: golden.prices.at(-1)!,
  real: { mean: 5.4013, dist: 0.0843, cheaperThan: 0.3, days: 6331 },
})!;

function telegram() {
  const sent: Record<string, unknown>[] = [];
  const fetch: Deps["fetch"] = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 100 + sent.length } });
  };
  return { sent, deps: (ms: number): Deps => ({ clock: fixedClock(ms), fetch }) };
}

// Quarta 14/10/2026: 10h e 23h de Brasília
const WED_10H = Date.parse("2026-10-14T13:00:00Z");
const WED_23H = Date.parse("2026-10-15T02:00:00Z");

beforeEach(async () => {
  await env.DB.batch(
    ["alert_outcomes", "alerts", "epochs", "state", "config"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

describe("alertas no Telegram", () => {
  it("boa época começa na 2ª leitura: envia com botões e registra o episódio", async () => {
    const tg = telegram();
    await processAlerts(env, tg.deps(WED_10H), WED_10H, signal);
    expect(tg.sent).toHaveLength(0); // 1ª leitura: ainda confirmando
    await processAlerts(env, tg.deps(WED_10H + 15 * 60_000), WED_10H + 15 * 60_000, signal);

    expect(tg.sent).toHaveLength(1);
    expect(String(tg.sent[0]!.text)).toContain("<b>Boa época</b>");
    const kb = tg.sent[0]!.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    expect(kb.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual([
      expect.stringMatching(/^ai:\d+$/),
      expect.stringMatching(/^chart:\d+$/),
      "mute:24h",
    ]);

    const alert = await env.DB.prepare(
      "SELECT kind, level, delivered, tg_message_id, epoch_id FROM alerts",
    ).first();
    expect(alert).toMatchObject({ kind: "epoca_inicio", level: "boa", delivered: 1, tg_message_id: 101 });
    const epoch = await env.DB.prepare("SELECT id, max_level, source, end_ts FROM epochs").first();
    expect(epoch).toMatchObject({ id: alert!.epoch_id, max_level: "boa", source: "live", end_ts: null });

    // a mesma situação nas leituras seguintes não repete o alerta
    await processAlerts(env, tg.deps(WED_10H + 30 * 60_000), WED_10H + 30 * 60_000, signal);
    expect(tg.sent).toHaveLength(1);
  });

  it("fora do horário (22h–8h) segura o alerta e ele aparece no resumo das 8h", async () => {
    const tg = telegram();
    await processAlerts(env, tg.deps(WED_23H), WED_23H, signal);
    await processAlerts(env, tg.deps(WED_23H + 15 * 60_000), WED_23H + 15 * 60_000, signal);
    expect(tg.sent).toHaveLength(0);
    const alert = await env.DB.prepare("SELECT delivered, context FROM alerts").first<{
      delivered: number;
      context: string;
    }>();
    expect(alert!.delivered).toBe(0);
    expect(JSON.parse(alert!.context).held).toBe("fora_do_horario");

    await env.DB.prepare(
      "INSERT INTO signals (ts, price, dist250, pct250, dist1260, pct1260, real_dist, real_pct, slope250, " +
        "above_sma20, above_sma50, score, components) VALUES (?, 5.8564, -0.0327, 0.82, 0.009, 0.48, 0.084, 0.3, -0.019, 0, 0, 71, '{}')",
    )
      .bind(WED_23H)
      .run();
    const THU_8H = Date.parse("2026-10-15T11:00:00Z");
    await summary(env, tg.deps(THU_8H));
    expect(tg.sent).toHaveLength(1);
    const text = String(tg.sent[0]!.text);
    expect(text).toContain("☀️ <b>Resumo</b> · qui 15/10");
    expect(text).toContain("Boa época ativa desde 14/10");
    expect(text).toContain("12 meses −3,3% · 5 anos +0,9%");
    expect(text).toContain("<b>Durante a noite</b>");
    expect(text).toContain("• Boa época começou (boa) — 14/10 23h15");
  });

  it("modo silencioso registra sem enviar e sem ir para o resumo", async () => {
    await env.DB.prepare("INSERT INTO config (key, value) VALUES ('alerts', '{\"dryRun\":true}')").run();
    const tg = telegram();
    await processAlerts(env, tg.deps(WED_10H), WED_10H, signal);
    await processAlerts(env, tg.deps(WED_10H + 15 * 60_000), WED_10H + 15 * 60_000, signal);
    expect(tg.sent).toHaveLength(0);
    const alert = await env.DB.prepare("SELECT context FROM alerts").first<{ context: string }>();
    expect(JSON.parse(alert!.context).held).toBe("dry_run");
  });

  it("época já aberta (vinda do histórico) não avisa 'começou' de novo, só o nível novo", async () => {
    await setState(
      env.DB,
      "epoch_state",
      {
        active: true,
        epochId: null,
        startTs: Date.parse("2026-09-22T21:00:00Z"),
        entryPrice: 5.9,
        minPrice: 5.84,
        minDist: -0.035,
        minTs: Date.parse("2026-09-23T21:00:00Z"),
        levelAlerted: "boa",
        pendingEnter: 0,
        pendingExit: 0,
        pendingLevel: null,
        lastSurgeTs: null,
        lastSeasonal: null,
      },
      0,
    );
    const deeper = computeSignal({
      closes: golden.prices.slice(0, -1),
      live: 5.5776, // ~7,8% abaixo da média
      real: signal.real,
    })!;
    const tg = telegram();
    await processAlerts(env, tg.deps(WED_10H), WED_10H, deeper);
    await processAlerts(env, tg.deps(WED_10H + 15 * 60_000), WED_10H + 15 * 60_000, deeper);
    expect(tg.sent).toHaveLength(1);
    expect(String(tg.sent[0]!.text)).toContain("<b>Boa época ficou melhor</b>");
    expect(String(tg.sent[0]!.text)).toContain("Desde o início (22/09)");
  });
});

describe("botão 🔕 24h", () => {
  it("silencia por 24 horas e os alertas seguintes ficam para o resumo", async () => {
    const tg = telegram();
    const req = new Request("https://euro-alert.test/telegram/webhook", {
      method: "POST",
      headers: { [SECRET_HEADER]: "test-secret" },
      body: JSON.stringify({
        update_id: 9001,
        callback_query: { id: "cb1", from: { id: 42 }, data: "mute:24h", message: { chat: { id: 42 } } },
      }),
    });
    expect((await handleWebhook(req, env, tg.deps(WED_10H))).status).toBe(200);
    expect(tg.sent[0]).toMatchObject({
      callback_query_id: "cb1",
      text: expect.stringContaining("silenciados por 24h"),
    });
    expect(await getState<number>(env.DB, "mute_until")).toBe(WED_10H + 24 * 3600_000);

    await processAlerts(env, tg.deps(WED_10H), WED_10H, signal);
    await processAlerts(env, tg.deps(WED_10H + 15 * 60_000), WED_10H + 15 * 60_000, signal);
    expect(tg.sent).toHaveLength(1); // só a resposta do botão
    const alert = await env.DB.prepare("SELECT context FROM alerts").first<{ context: string }>();
    expect(JSON.parse(alert!.context).held).toBe("silenciado");
  });
});
