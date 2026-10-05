import { describe, expect, it, vi } from "vitest";
import { type FetchFn, HttpError, http, redact } from "../../src/lib/http";

const noSleep = async () => {};

function fakeFetch(...responses: (Response | Error)[]) {
  return vi.fn<FetchFn>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("sem mais respostas");
    if (next instanceof Error) throw next;
    return next;
  });
}

describe("http", () => {
  it("devolve a resposta de sucesso e manda user-agent", async () => {
    const f = fakeFetch(new Response("ok"));
    const res = await http("https://x.test/a", { fetchImpl: f, sleep: noSleep });
    expect(await res.text()).toBe("ok");
    const init = f.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("user-agent")).toMatch(/euro-alert/);
  });

  it("repete em 5xx e erro de rede", async () => {
    const f = fakeFetch(new Response("", { status: 503 }), new TypeError("rede"), new Response("ok"));
    const res = await http("https://x.test/a", { fetchImpl: f, sleep: noSleep, retries: 2 });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("não repete em 4xx", async () => {
    const f = fakeFetch(new Response("nope", { status: 401 }), new Response("ok"));
    await expect(http("https://x.test/a", { fetchImpl: f, sleep: noSleep })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("respeita o Retry-After do 429", async () => {
    const sleep = vi.fn(noSleep);
    const f = fakeFetch(
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
      new Response("ok"),
    );
    await http("https://x.test/a", { fetchImpl: f, sleep });
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("lança o último erro quando as tentativas acabam", async () => {
    const f = fakeFetch(new Response("", { status: 500 }), new Response("", { status: 502 }));
    const err = await http("https://x.test/a", { fetchImpl: f, sleep: noSleep, retries: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
  });

  it("tira o token do Telegram da URL nas mensagens de erro", () => {
    expect(redact("https://api.telegram.org/bot123:ABC/sendMessage")).toBe(
      "https://api.telegram.org/bot***/sendMessage",
    );
  });
});
