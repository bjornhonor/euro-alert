/**
 * Registra o webhook do bot no Telegram.
 *
 *   npm run set-webhook -- https://euro-alert.<sua-conta>.workers.dev
 *
 * Lê TELEGRAM_BOT_TOKEN e TELEGRAM_WEBHOOK_SECRET do .dev.vars (o mesmo segredo precisa estar
 * no Worker: `wrangler secret put TELEGRAM_WEBHOOK_SECRET`).
 */
const [workerUrl] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!workerUrl || !/^https:\/\//.test(workerUrl)) {
  console.error("Uso: npm run set-webhook -- https://euro-alert.<sua-conta>.workers.dev");
  process.exit(1);
}
if (!token || !secret) {
  console.error("Preencha TELEGRAM_BOT_TOKEN e TELEGRAM_WEBHOOK_SECRET no .dev.vars.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET só pode ter letras, números, _ e - (até 256).");
  process.exit(1);
}

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const url = new URL("/telegram/webhook", workerUrl).toString();
await call("setWebhook", {
  url,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
const info = (await call("getWebhookInfo", {})) as { url: string; pending_update_count: number };
console.log(`Webhook registrado: ${info.url} (pendentes: ${info.pending_update_count})`);

export {};
