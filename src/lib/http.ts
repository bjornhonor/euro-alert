export const DEFAULT_USER_AGENT = "euro-alert/0.1 (uso pessoal)";
/** Algumas fontes (Wise pública, Yahoo) recusam user-agent de robô. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  userAgent?: string;
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status} em ${redact(url)}`);
    this.name = "HttpError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Tira tokens da URL antes de logar (a API do Telegram põe o token no caminho). */
export function redact(url: string): string {
  return url.replace(/\/bot[^/]+\//, "/bot***/");
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  return Number.isFinite(s) ? s * 1000 : undefined;
}

/**
 * fetch com timeout, retry exponencial (erro de rede, timeout, 408, 429 e 5xx) e user-agent.
 * Devolve a resposta de sucesso; lança HttpError para status de erro que não vale repetir
 * ou quando as tentativas acabam.
 */
export async function http(url: string, opts: HttpOptions = {}): Promise<Response> {
  const {
    timeoutMs = 10_000,
    retries = 2,
    baseDelayMs = 500,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = fetch,
    sleep = defaultSleep,
    ...init
  } = opts;
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", userAgent);

  let lastError: unknown;
  let hintMs: number | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(hintMs ?? backoff, 10_000));
      hintMs = undefined;
    }
    try {
      const res = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      lastError = new HttpError(url, res.status, body.slice(0, 500));
      if (!isRetryableStatus(res.status)) break;
      hintMs = retryAfterMs(res);
    } catch (err) {
      lastError = err; // erro de rede ou timeout
    }
  }
  throw lastError;
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await http(url, opts);
  return (await res.json()) as T;
}
