import { epochAt, type EpochMetrics, YEAR } from "./epoch";
import { type Band, decompose, type Decomposition, projectionBand } from "./market";
import { type RealContext } from "./real-rate";
import { scoreAt, type ScoreResult } from "./score";

/** Precisa de 1 ano + o trimestre da inclinação; com menos, não há sinal. */
export const MIN_DAYS = YEAR + 63 + 1;

export interface SignalInput {
  /** Fechamentos diários do EUR/BRL até ontem, do mais antigo ao mais novo. */
  closes: readonly number[];
  /** Preço ao vivo: entra como último ponto (provisório) da série. */
  live: number;
  real?: RealContext;
  /** Índice sazonal do mês atual (% contra a tendência), se já calculado. */
  seasonal?: { month: number; mean: number; n: number };
  /** Séries do EUR/USD e USD/BRL (fechamentos + ao vivo) para a decomposição. */
  eurusd?: readonly number[];
  usdbrl?: readonly number[];
}

export interface Signal {
  epoch: EpochMetrics;
  score: ScoreResult;
  real?: RealContext;
  seasonal?: SignalInput["seasonal"];
  projection: Band[];
  decomposition: Decomposition[];
}

/** Junta todos os indicadores do momento (função pura). */
export function computeSignal(input: SignalInput): Signal | undefined {
  const prices = [...input.closes, input.live];
  if (prices.length < MIN_DAYS) return undefined;
  const score = scoreAt(prices);
  const decomposition =
    input.eurusd && input.usdbrl
      ? [1, 5, 20].flatMap((d) => decompose(input.eurusd!, input.usdbrl!, d) ?? [])
      : [];
  return {
    epoch: epochAt(prices),
    score,
    real: input.real,
    seasonal: input.seasonal,
    projection: [5, 21].map((d) => projectionBand(input.live, score.sd60, d)),
    decomposition,
  };
}
