import { type Deps } from "../deps";
import { errorFields, log } from "../lib/log";
import { TelegramApi } from "./api";

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number } } };
}

export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Comparação em tempo constante para o segredo do webhook. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function chatIdOf(update: Update): number | undefined {
  return update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? update.callback_query?.from.id;
}

/**
 * POST /telegram/webhook. Recusa sem o segredo; ignora updates repetidos (o Telegram reenvia
 * se não receber 200) e qualquer chat que não seja o seu. Os comandos completos chegam na Etapa 6.
 */
export async function handleWebhook(request: Request, env: Env, deps: Deps): Promise<Response> {
  const secret = request.headers.get(SECRET_HEADER) ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = await request.json<Update>();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (typeof update.update_id !== "number") return new Response("bad request", { status: 400 });

  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO tg_updates (update_id, ts) VALUES (?, ?)")
    .bind(update.update_id, deps.clock.now())
    .run();
  if (inserted.meta.changes === 0) return new Response("ok"); // repetido

  const chatId = chatIdOf(update);
  if (chatId === undefined || String(chatId) !== env.TELEGRAM_CHAT_ID) {
    log("warn", "telegram: update de chat desconhecido ignorado", { update_id: update.update_id });
    return new Response("ok");
  }

  try {
    await reply(update, env, deps);
  } catch (err) {
    // Responde 200 mesmo assim: com erro, o Telegram reenviaria o mesmo update sem parar.
    log("error", "telegram: falha ao responder", { update_id: update.update_id, ...errorFields(err) });
  }
  return new Response("ok");
}

async function reply(update: Update, env: Env, deps: Deps): Promise<void> {
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  if (update.callback_query) {
    await api.call("answerCallbackQuery", { callback_query_id: update.callback_query.id });
    return;
  }
  const text = update.message?.text?.trim() ?? "";
  const command = text.split(/[\s@]/)[0]?.toLowerCase();
  const html =
    command === "/start"
      ? "Olá! Sou o <b>Euro Alert</b>. Vou avisar aqui quando o euro entrar numa boa época de compra."
      : "Ainda estou em construção: os comandos chegam em breve.";
  await api.sendMessage(env.TELEGRAM_CHAT_ID, html);
}
