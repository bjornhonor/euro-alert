import { setState } from "../db/state";
import { type Deps } from "../deps";

/** Etapa 1: só registra que rodou. A coleta entra na Etapa 2 e os alertas na Etapa 4. */
export async function tick(env: Env, deps: Deps): Promise<void> {
  const now = deps.clock.now();
  await setState(env.DB, "last_tick", now, now);
}
