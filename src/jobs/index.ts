import { type Deps } from "../deps";
import { log } from "../lib/log";
import { type JobName, jobForCron } from "./crons";
import { maintenance } from "./maintenance";
import { summary } from "./summary";
import { tick } from "./tick";

type Job = (env: Env, deps: Deps) => Promise<void>;

const notYet =
  (name: string): Job =>
  async () => {
    log("info", `${name}: ainda não implementado`);
  };

const JOBS: Record<JobName, Job> = {
  tick,
  summary, // a IA macro entra na Etapa 8
  weekly: notYet("relatório semanal"), // Etapa 6
  maintenance,
};

export async function runScheduled(cron: string, env: Env, deps: Deps): Promise<JobName> {
  const name = jobForCron(cron);
  if (!name) throw new Error(`cron desconhecido: ${cron}`);
  const started = Date.now();
  await JOBS[name](env, deps);
  log("info", "job concluído", { job: name, ms: Date.now() - started });
  return name;
}
