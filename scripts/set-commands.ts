/**
 * Registra o menu de comandos do bot no Telegram (aparece ao digitar "/").
 *
 *   npm run set-commands
 *
 * Lê TELEGRAM_BOT_TOKEN do .dev.vars.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Preencha TELEGRAM_BOT_TOKEN no .dev.vars.");
  process.exit(1);
}

const commands = [
  { command: "agora", description: "O euro agora: preço, nível, comparações e custo na Wise" },
  { command: "epoca", description: "A boa época atual e as anteriores" },
  { command: "grafico", description: "Gráfico (90d, 1a ou 5a)" },
  { command: "placar", description: "Como as boas épocas se saíram" },
  { command: "analise", description: "Leitura da IA sobre o momento do euro" },
  { command: "pausar", description: "Silencia os alertas (ex.: 3d, 12h)" },
  { command: "retomar", description: "Volta a avisar" },
  { command: "alertas", description: "Liga e desliga os alertas opcionais" },
  { command: "status", description: "Saúde do sistema" },
  { command: "ajuda", description: "Lista de comandos" },
];

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ commands }),
});
const data = (await res.json()) as { ok: boolean; description?: string };
if (!data.ok) {
  console.error(`setMyCommands: ${data.description}`);
  process.exit(1);
}
console.log(`Menu registrado com ${commands.length} comandos.`);

export {};
