import { type Deps } from "./deps";
import { CRONS, type JobName } from "./jobs/crons";
import { runScheduled } from "./jobs";
import { errorFields } from "./lib/log";
import { safeEqual } from "./lib/crypto";

/**
 * POST /admin/run?job=tick|summary|weekly|maintenance — roda um job na hora, sem esperar o cron.
 * Protegido pelo segredo ADMIN_TOKEN (header `Authorization: Bearer <token>`). Sem o segredo
 * configurado, a rota fica desligada.
 */
export async function handleAdminRun(request: Request, env: Env, deps: Deps): Promise<Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!env.ADMIN_TOKEN || !safeEqual(token, env.ADMIN_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  const job = new URL(request.url).searchParams.get("job") as JobName | null;
  if (!job || !Object.hasOwn(CRONS, job)) {
    return Response.json(
      { ok: false, error: `job inválido; use: ${Object.keys(CRONS).join(", ")}` },
      { status: 400 },
    );
  }
  const started = Date.now();
  try {
    await runScheduled(CRONS[job], env, deps);
    return Response.json({ ok: true, job, ms: Date.now() - started });
  } catch (err) {
    return Response.json({ ok: false, job, ms: Date.now() - started, ...errorFields(err) }, { status: 500 });
  }
}
