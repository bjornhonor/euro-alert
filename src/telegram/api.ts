import { type FetchFn, http } from "../lib/http";

export interface SendMessageOptions {
  replyMarkup?: unknown;
  silent?: boolean;
}

export interface TelegramMessage {
  message_id: number;
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly description: string,
  ) {
    super(`Telegram ${method}: ${description}`);
    this.name = "TelegramError";
  }
}

/** Cliente mínimo da Bot API. Mensagens sempre em HTML (escape o texto com `escapeHtml`). */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchFn,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await http(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      fetchImpl: this.fetchImpl,
      retries: 2,
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new TelegramError(method, data.description ?? "erro desconhecido");
    return data.result as T;
  }

  editMessageText(chatId: string, messageId: number, html: string, replyMarkup?: unknown): Promise<unknown> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  sendPhoto(chatId: string, photoUrl: string, captionHtml: string): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      caption: captionHtml,
      parse_mode: "HTML",
    });
  }

  sendMessage(chatId: string, html: string, opts: SendMessageOptions = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: opts.silent ?? false,
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
