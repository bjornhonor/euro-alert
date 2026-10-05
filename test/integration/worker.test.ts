import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src";
import { getState } from "../../src/db/state";
import { CRONS } from "../../src/jobs/crons";
import { SECRET_HEADER } from "../../src/telegram/webhook";

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.telegram.org/")) return new Response("fora do ar", { status: 404 });
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function call(request: Request): Promise<Response> {
  return worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env);
}

function webhook(update: unknown, secret = "test-secret"): Request {
  return new Request("https://euro-alert.test/telegram/webhook", {
    method: "POST",
    headers: { [SECRET_HEADER]: secret, "content-type": "application/json" },
    body: JSON.stringify(update),
  });
}

function runCron(cron: string): Promise<void> {
  return worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env);
}

describe("fetch", () => {
  it("GET /health responde 200", async () => {
    const res = await call(new Request("https://euro-alert.test/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("outras rotas dão 404", async () => {
    expect((await call(new Request("https://euro-alert.test/"))).status).toBe(404);
  });
});

describe("webhook do Telegram", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await call(webhook({ update_id: 1 }, "errado"));
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("responde /start no seu chat", async () => {
    const res = await call(webhook({ update_id: 10, message: { chat: { id: 42 }, text: "/start" } }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/sendMessage$/);
    expect(sent[0]!.body).toMatchObject({ chat_id: "42", parse_mode: "HTML" });
  });

  it("ignora update repetido", async () => {
    const update = { update_id: 11, message: { chat: { id: 42 }, text: "/start" } };
    await call(webhook(update));
    await call(webhook(update));
    expect(sent).toHaveLength(1);
  });

  it("ignora outros chats", async () => {
    const res = await call(webhook({ update_id: 12, message: { chat: { id: 999 }, text: "/start" } }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("responde 200 mesmo se o Telegram falhar (senão ele reenvia sem parar)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 400 }));
    const res = await call(webhook({ update_id: 13, message: { chat: { id: 42 }, text: "/start" } }));
    expect(res.status).toBe(200);
  });

  it("recusa corpo inválido", async () => {
    const req = new Request("https://euro-alert.test/telegram/webhook", {
      method: "POST",
      headers: { [SECRET_HEADER]: "test-secret" },
      body: "{",
    });
    expect((await call(req)).status).toBe(400);
  });
});

describe("crons", () => {
  it("manutenção manda o olá uma vez só", async () => {
    await runCron(CRONS.maintenance);
    await runCron(CRONS.maintenance);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ chat_id: "42", disable_notification: true });
    expect(await getState(env.DB, "hello_sent")).toBe(true);
  });

  it("tick registra a execução", async () => {
    await runCron(CRONS.tick);
    expect(await getState<number>(env.DB, "last_tick")).toBeTypeOf("number");
  });

  it("resumo e relatório rodam sem erro", async () => {
    await runCron(CRONS.summary);
    await runCron(CRONS.weekly);
  });

  it("cron desconhecido falha", async () => {
    await expect(runCron("1 2 3 4 5")).rejects.toThrow(/cron desconhecido/);
  });
});
