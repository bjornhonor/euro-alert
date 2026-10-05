import { type Deps } from "../deps";
import { isAlertWindow } from "../lib/time";
import { TelegramApi } from "./api";

/**
 * Alerta de sistema (fonte fora do ar, tarifa mudou…). Fica registrado em `alerts`.
 * Fora da janela de alertas (8h–22h, dias úteis) vai sem som, para não acordar ninguém.
 */
export async function sendSystemAlert(env: Env, deps: Deps, html: string): Promise<void> {
  const now = deps.clock.now();
  const silent = !isAlertWindow(now, Number(env.ALERT_START_HOUR), Number(env.ALERT_END_HOUR));
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  const msg = await api.sendMessage(env.TELEGRAM_CHAT_ID, html, { silent });
  await env.DB.prepare(
    "INSERT INTO alerts (ts, kind, context, tg_message_id, delivered) VALUES (?, 'sistema', ?, ?, 1)",
  )
    .bind(now, JSON.stringify({ text: html }), msg.message_id)
    .run();
}
