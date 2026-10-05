import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false, // testes nunca tocam a conta da Cloudflare
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_BOT_TOKEN: "test-token",
            TELEGRAM_WEBHOOK_SECRET: "test-secret",
            TELEGRAM_CHAT_ID: "42",
            ADMIN_TOKEN: "test-admin",
            GROQ_API_KEY: "", // sem IA por padrão (o .dev.vars tem a chave real); os testes da IA ligam
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // Cada arquivo sobe um workerd; muitos ao mesmo tempo estouram o tempo de início no Windows.
      maxWorkers: 2,
    },
  };
});
