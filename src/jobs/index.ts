import { type Deps } from "../deps";
import { log } from "../lib/log";
import { type JobName, jobForCron } from "./crons";
import { maintenance } from "./maintenance";
import { summary } from "./summary";
import { tick } from "./tick";
import { weekly } from "./weekly";

type Job = (env: Env, deps: Deps) => Promise<void>;

const JOBS: Record<JobName, Job> = {
  tick,
  summary, // a IA macro entra na Etapa 8
  weekly,
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
