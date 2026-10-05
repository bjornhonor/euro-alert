import { type Deps } from "../deps";
import { log } from "../lib/log";
import { type JobName, jobForCron } from "./crons";
import { maintenance } from "./maintenance";
import { tick } from "./tick";

type Job = (env: Env, deps: Deps) => Promise<void>;

const notYet =
  (name: string): Job =>
  async () => {
    log("info", `${name}: ainda não implementado`);
  };

const JOBS: Record<JobName, Job> = {
  tick,
  summary: notYet("resumo das 8h"), // Etapa 4 (resumo) e Etapa 8 (IA macro)
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
