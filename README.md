# euro-alert

Alertas no Telegram para boas épocas de comprar euro (EUR/BRL, com base na Wise). Roda de graça em Cloudflare Workers + D1.
O plano completo está em [docs/PLANO.md](docs/PLANO.md); a pesquisa que embasa os sinais, em [research/](research/).

## Desenvolvimento

```bash
npm install
npm run db:migrate:local
npm run dev                      # Worker local em http://localhost:8787
```

Arquivos locais, todos fora do git (nem modelo vai pro repositório):

| Arquivo     | Quem lê              | Variáveis                                                                                                                          |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `.env`      | wrangler (CLI)       | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                                                                                    |
| `.dev.vars` | Worker rodando local | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CHAT_ID`, `WISE_API_TOKEN` (opcional), `GEMINI_API_KEY`, `GROQ_API_KEY` |

Disparar um cron localmente (com `npm run dev` rodando):

```bash
curl "localhost:8787/cdn-cgi/local/scheduled?cron=0+6+*+*+*"
```

| Script                                        | O que faz                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm test`                                    | testes no runtime dos Workers (D1 local, rede simulada)                                |
| `npm run typecheck`                           | TypeScript do app, dos testes e dos scripts                                            |
| `npm run lint`                                | ESLint + Prettier (`npm run format` corrige)                                           |
| `npm run backfill -- --local` (ou `--remote`) | carrega o histórico: câmbio desde 2002, Selic, IPCA e inflação do euro                 |
| `npm run cf-typegen`                          | regera `worker-configuration.d.ts` depois de mudar o `wrangler.jsonc` ou o `.dev.vars` |

## Colocar no ar (primeira vez)

O projeto usa a conta pessoal da Cloudflare (`account_id` fixo no `wrangler.jsonc`). As credenciais ficam no `.env`
e valem só aqui: o `wrangler login` da máquina não é usado. Confira com `npx wrangler whoami`.

1. ✅ Banco criado (`wrangler d1 create euro-alert`) e migrações aplicadas (`npm run db:migrate:remote`).
2. Criar o bot no @BotFather (`/newbot`), mandar uma mensagem pra ele e pegar o `chat_id` em `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. Preencher o `.dev.vars` (local) com os mesmos valores dos segredos abaixo.
4. Segredos (gere o do webhook com letras, números, `_` ou `-`):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```
5. `npm run deploy` e conferir `https://euro-alert.<sua-conta>.workers.dev/health`.
6. `npm run set-webhook -- https://euro-alert.<sua-conta>.workers.dev` e mandar `/start` pro bot.

O cron de manutenção (3h de Brasília) manda um "olá" na primeira vez que roda.
