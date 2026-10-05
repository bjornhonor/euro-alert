import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { log } from "../lib/log";
import { TelegramApi } from "../telegram/api";

const TG_UPDATES_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Manutenção das 3h. Etapa 1: manda o "olá" uma única vez (prova de que cron, D1 e Telegram
 * estão ligados) e limpa a tabela de idempotência do webhook. A Etapa 2 adiciona fechamento
 * diário, curva de tarifa, séries macro e limpeza de `rates`.
 */
export async function maintenance(env: Env, deps: Deps): Promise<void> {
  const now = deps.clock.now();

  await env.DB.prepare("DELETE FROM tg_updates WHERE ts < ?")
    .bind(now - TG_UPDATES_RETENTION_MS)
    .run();

  if (!(await getState<boolean>(env.DB, "hello_sent"))) {
    const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
    await api.sendMessage(
      env.TELEGRAM_CHAT_ID,
      `👋 Olá! O <b>Euro Alert</b> está no ar (${env.ENVIRONMENT}). Cron, banco e Telegram funcionando.`,
      { silent: true },
    );
    await setState(env.DB, "hello_sent", true, now);
    log("info", "olá enviado no Telegram");
  }
}
