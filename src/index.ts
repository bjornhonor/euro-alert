import { defaultDeps } from "./deps";
import { runScheduled } from "./jobs";
import { errorFields, log } from "./lib/log";
import { handleWebhook } from "./telegram/webhook";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }
    if (request.method === "POST" && pathname === "/telegram/webhook") {
      return handleWebhook(request, env, defaultDeps());
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller, env): Promise<void> {
    try {
      await runScheduled(controller.cron, env, defaultDeps());
    } catch (err) {
      log("error", "job falhou", { cron: controller.cron, ...errorFields(err) });
      throw err; // aparece como falha no painel da Cloudflare
    }
  },
} satisfies ExportedHandler<Env>;
