import { type FetchFn } from "./lib/http";
import { type Clock, systemClock } from "./lib/time";

/** O que vem de fora (relógio e rede), injetado para os testes controlarem. */
export interface Deps {
  clock: Clock;
  fetch: FetchFn;
}

export function defaultDeps(): Deps {
  return { clock: systemClock, fetch: (input, init) => fetch(input, init) };
}
