/**
 * Roda um job do Worker na hora, sem esperar o cron.
 *
 *   npm run job -- tick            # na Cloudflare
 *   npm run job -- maintenance
 *   npm run job -- tick --local    # no `npm run dev` (http://localhost:8787)
 *
 * Usa o ADMIN_TOKEN do .dev.vars (o mesmo valor cadastrado com `wrangler secret put ADMIN_TOKEN`).
 */
const WORKER_URL = "https://euro-alert.brunocarrarabpc.workers.dev";
const JOBS = ["tick", "summary", "weekly", "maintenance"];

const args = process.argv.slice(2);
const job = args.find((a) => !a.startsWith("--"));
const base = args.includes("--local") ? "http://localhost:8787" : WORKER_URL;
const token = process.env.ADMIN_TOKEN;

if (!job || !JOBS.includes(job)) {
  console.error(`Uso: npm run job -- <${JOBS.join("|")}> [--local]`);
  process.exit(1);
}
if (!token) {
  console.error("Preencha ADMIN_TOKEN no .dev.vars.");
  process.exit(1);
}

const res = await fetch(`${base}/admin/run?job=${job}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
const body = await res.text();
console.log(`${res.status} ${body}`);
process.exit(res.ok ? 0 : 1);

export {};
