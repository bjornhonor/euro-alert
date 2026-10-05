import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import golden from "../fixtures/golden.json";
import { getState } from "../../src/db/state";
import { type Deps } from "../../src/deps";
import { refreshHistory } from "../../src/jobs/signals";
import { weekly } from "../../src/jobs/weekly";
import { fixedClock } from "../../src/lib/time";
import { handleCommand } from "../../src/telegram/commands";
import { handleWebhook, SECRET_HEADER } from "../../src/telegram/webhook";

const { dates, prices, ipca, hicp } = golden;
// Quinta 24/09/2026, 10h de Brasília: o último fechamento é 23/09
const NOW = Date.parse("2026-09-24T13:00:00Z");

function network() {
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  const quickchart: unknown[] = [];
  const fetch: Deps["fetch"] = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.startsWith("https://api.telegram.org/")) {
      telegram.push({ method: url.split("/").pop()!, body });
      return Response.json({ ok: true, result: { message_id: telegram.length } });
    }
    if (url === "https://quickchart.io/chart/create") {
      quickchart.push(body);
      return Response.json({ success: true, url: "https://quickchart.io/chart/render/zm-teste" });
    }
    return new Response("fora do ar", { status: 404 });
  };
  return { telegram, quickchart, deps: { clock: fixedClock(NOW), fetch } satisfies Deps };
}

beforeAll(async () => {
  const ins = env.DB.prepare(
    "INSERT INTO daily_close (pair, date, close, source) VALUES ('EURBRL', ?, ?, 'ecb')",
  );
  const rows = dates.map((d, j) => ins.bind(d, prices[j]!));
  for (let i = 0; i < rows.length; i += 500) await env.DB.batch(rows.slice(i, i + 500));
  const macro = env.DB.prepare("INSERT INTO macro_series (series, date, value) VALUES (?, ?, ?)");
  await env.DB.batch([
    ...ipca.map((o) => macro.bind("ipca", o.date, o.value)),
    ...hicp.map((o) => macro.bind("hicp_ea", o.date, o.value)),
  ]);
  await refreshHistory(env, NOW);
  await env.DB.prepare("INSERT INTO rates (pair, ts, mid, source) VALUES ('EURBRL', ?, 5.8, 'wise-public')")
    .bind(NOW - 5 * 60_000)
    .run();
  await env.DB.prepare(
    "INSERT INTO epochs (start_ts, end_ts, entry_price, min_price, min_dist, min_ts, max_level, source) " +
      "VALUES (?, NULL, 5.86, 5.84, -0.035, ?, 'boa', 'backfill')",
  )
    .bind(Date.parse("2026-09-22T21:00:00Z"), Date.parse("2026-09-23T21:00:00Z"))
    .run();
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM config"),
    env.DB.prepare("DELETE FROM state WHERE key = 'mute_until'"),
  ]);
});

const lastText = (n: ReturnType<typeof network>) => String(n.telegram.at(-1)!.body.text);

describe("comandos", () => {
  it("/agora: preço ao vivo, nível, comparação e faixa provável", async () => {
    const n = network();
    await handleCommand("/agora", env, n.deps);
    const text = lastText(n);
    expect(text).toContain("<b>Euro agora</b>");
    expect(text).toContain("<b>R$ 5,8000</b> por euro");
    expect(text).toMatch(/\d+,\d% abaixo da média de 12 meses/);
    expect(text).toContain("<b>Para comparar</b>");
    expect(text).toContain("<b>Faixa provável (68%)</b>");
    expect(text).toContain("Atualizado às 09h55 (wise-public)");
  });

  it("/epoca: época aberta, com começo e mínimo", async () => {
    const n = network();
    await handleCommand("/epoca", env, n.deps);
    expect(lastText(n)).toContain("<b>Boa época ativa</b>");
    expect(lastText(n)).toContain("Desde 22/09 (há 2 dias)");
  });

  it("/grafico 90d: gera no QuickChart e manda a foto", async () => {
    const n = network();
    await handleCommand("/grafico 90d", env, n.deps);
    expect(n.quickchart).toHaveLength(1);
    expect(n.telegram.at(-1)).toMatchObject({
      method: "sendPhoto",
      body: { photo: "https://quickchart.io/chart/render/zm-teste" },
    });
  });

  it("/pausar 3d e /retomar", async () => {
    const n = network();
    await handleCommand("/pausar 3d", env, n.deps);
    expect(await getState<number>(env.DB, "mute_until")).toBe(NOW + 3 * 86_400_000);
    expect(lastText(n)).toContain("Alertas pausados até 27/09 às 10h00");
    await handleCommand("/retomar", env, n.deps);
    expect(await getState(env.DB, "mute_until")).toBeNull();
  });

  it("comando desconhecido aponta para /ajuda", async () => {
    const n = network();
    await handleCommand("/qualquercoisa", env, n.deps);
    expect(lastText(n)).toContain("/ajuda");
  });

  it("/status mostra coleta, manutenção e alertas", async () => {
    const n = network();
    await handleCommand("/status", env, n.deps);
    expect(lastText(n)).toContain("<b>Status</b>");
    expect(lastText(n)).toContain("Coletas hoje: 1");
  });
});

describe("botões", () => {
  const callback = (data: string, id: number) =>
    new Request("https://euro-alert.test/telegram/webhook", {
      method: "POST",
      headers: { [SECRET_HEADER]: "test-secret" },
      body: JSON.stringify({
        update_id: id,
        callback_query: {
          id: `cb${id}`,
          from: { id: 42 },
          data,
          message: { chat: { id: 42 }, message_id: 77 },
        },
      }),
    });

  it("/alertas: o botão liga e desliga e atualiza o teclado", async () => {
    const n = network();
    await handleWebhook(callback("cfg:surge", 501), env, n.deps);
    const cfg = await env.DB.prepare("SELECT value FROM config WHERE key = 'alerts'").first<{
      value: string;
    }>();
    expect(JSON.parse(cfg!.value)).toEqual({ surge: false });
    expect(n.telegram.map((t) => t.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
  });

  it("📈 manda o gráfico de 1 ano", async () => {
    const n = network();
    await handleWebhook(callback("chart:12", 502), env, n.deps);
    expect(n.telegram.map((t) => t.method)).toEqual(["answerCallbackQuery", "sendPhoto"]);
  });
});

describe("relatório semanal", () => {
  it("variação da semana, época, placar e sistema", async () => {
    const n = network();
    await weekly(env, n.deps);
    const text = lastText(n);
    expect(text).toContain("📊 <b>Semana 39</b>");
    expect(text).toMatch(/na semana/);
    expect(text).toContain("<b>Sistema</b>");
    expect(n.telegram.at(-1)!.body.disable_notification).toBe(true);
  });
});
