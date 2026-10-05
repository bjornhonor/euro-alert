import { getState, setState } from "../db/state";
import { type Deps } from "../deps";
import { errorFields, log } from "../lib/log";
import { brt } from "../lib/time";
import { TelegramApi } from "../telegram/api";
import { renderNews } from "./news-analyst";
import { newsAnalysis } from "./run";

/**
 * Fila de análises pedidas pelo Telegram. A pesquisa com busca na web pode levar mais de um
 * minuto, e o Telegram não espera o webhook tanto tempo (a Cloudflare corta a execução quando
 * ele desiste). Então o clique só entra na fila, e o cron de cada minuto faz o trabalho.
 */
interface NewsRequest {
  ts: number;
  /** Mensagem "Pesquisando…" que vai ser trocada pelo resultado. */
  messageId: number;
  alertId?: number;
}

const KEY = "news_queue";

export async function enqueueNews(env: Env, deps: Deps, alertId?: number): Promise<void> {
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  const wait = await api.sendMessage(
    env.TELEGRAM_CHAT_ID,
    "🔎 Pesquisando as notícias que estão mexendo com o euro… (leva de 1 a 3 minutos)",
  );
  const now = deps.clock.now();
  const queue = (await getState<NewsRequest[]>(env.DB, KEY)) ?? [];
  queue.push({ ts: now, messageId: wait.message_id, alertId });
  await setState(env.DB, KEY, queue, now);
}

/** Cron de cada minuto: atende os pedidos da fila (normalmente nenhum). */
export async function processNewsQueue(env: Env, deps: Deps): Promise<number> {
  const queue = (await getState<NewsRequest[]>(env.DB, KEY)) ?? [];
  if (queue.length === 0) return 0;
  // tira da fila antes de começar: o próximo cron (daqui a 1 min) não pega o mesmo pedido
  await setState(env.DB, KEY, [], deps.clock.now());

  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN, deps.fetch);
  for (const req of queue) {
    let text = "🤖 A IA não conseguiu pesquisar agora. Tente de novo em alguns minutos.";
    try {
      const res = await newsAnalysis(env, deps, { alertId: req.alertId });
      if (res) {
        const t = brt(res.ts);
        text = renderNews(res.analysis, { date: t.date, hour: t.hour, minute: t.minute });
      }
    } catch (err) {
      log("error", "ia: análise falhou", errorFields(err));
    }
    await api.editMessageText(env.TELEGRAM_CHAT_ID, req.messageId, text);
  }
  return queue.length;
}
