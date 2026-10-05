import { type Deps } from "../deps";
import { setState } from "../db/state";
import { safeEqual } from "../lib/crypto";
import { errorFields, log } from "../lib/log";
import { TelegramApi } from "./api";
import { enqueueNews } from "../ai/queue";
import { alertsKeyboard, handleCommand, sendChart, toggleAlertOption } from "./commands";

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id?: number };
  };
}

export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

function chatIdOf(update: Update): number | undefined {
  return update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? update.callback_query?.from.id;
}

/**
 * POST /telegram/webhook. Recusa sem o segredo; ignora updates repetidos (o Telegram reenvia
 * se não receber 200) e qualquer chat que não seja o seu.
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
  const cb = update.callback_query;
  if (!cb) return handleCommand(update.message?.text ?? "", env, deps);

  const data = cb.data ?? "";
  // Responder o clique é só o aviso no topo da tela: se falhar (clique velho), segue o trabalho.
  const answer = (text: string) =>
    api
      .call("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: false })
      .catch((err) => log("warn", "telegram: resposta ao botão falhou", errorFields(err)));

  if (data === "mute:24h") {
    const now = deps.clock.now();
    await setState(env.DB, "mute_until", now + 24 * 60 * 60 * 1000, now);
    await answer("🔕 Alertas silenciados por 24h. O que acontecer vai para o resumo das 8h.");
  } else if (data.startsWith("chart:")) {
    await answer("📈 Gerando o gráfico…");
    await sendChart(env, deps, "1a");
  } else if (data.startsWith("cfg:")) {
    const key = data.slice(4);
    if (key !== "surge" && key !== "seasonal" && key !== "dryRun")
      return void (await answer("Opção desconhecida."));
    const cfg = await toggleAlertOption(env.DB, key);
    await answer(cfg[key] ? "Ligado ✅" : "Desligado");
    if (cb.message?.message_id) {
      await api.call("editMessageReplyMarkup", {
        chat_id: env.TELEGRAM_CHAT_ID,
        message_id: cb.message.message_id,
        reply_markup: alertsKeyboard(cfg),
      });
    }
  } else if (data.startsWith("ai:")) {
    await answer("🔎 Pesquisando as notícias…");
    await enqueueNews(env, deps, Number(data.slice(3)));
  } else {
    await answer("Botão desconhecido.");
  }
}
