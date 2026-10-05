import { comparisonLines, contextLines, wiseCostLine } from "../alerts/context";
import { ddmm, LEVEL_NAME, num, pct, rate } from "../alerts/format";
import { type ScoreSummary } from "../alerts/outcomes";
import { type Level, LEVELS } from "../engine/epoch";
import { type Signal } from "../engine/signal";
import { type FeeModel } from "../providers/wise-fees";
import { esc, LEVEL_ICON, nextLevels, priceLine, section, vs12m } from "./templates";

const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}`;

export interface NowView {
  signal: Signal;
  today: string;
  feeModel?: FeeModel;
  /** Época ativa (início e nível já avisado), se houver. */
  epoch?: { start: string; level: Level };
  updated: { hour: number; minute: number; source: string };
}

/** /agora: o momento do euro, no mesmo formato dos alertas. */
export function renderNow(v: NowView): string {
  const s = v.signal;
  const level = s.epoch.level;
  const next = nextLevels(s, level ?? "boa", LEVELS);
  const wise = wiseCostLine(v.feeModel, s.epoch.price);
  const [w, m] = s.projection;
  return esc([
    `${level ? LEVEL_ICON[level] : "💶"} <b>Euro agora</b>`,
    "",
    priceLine(s.epoch.price),
    vs12m(s.epoch.dist250),
    `Mais barato que ${pct(s.epoch.pct250, 0)} dos dias do último ano`,
    "",
    level
      ? `Nível: <b>${LEVEL_NAME[level]}</b>${v.epoch ? ` (boa época desde ${ddmm(v.epoch.start)})` : ""}`
      : `Fora de boa época · começa em ${pct(LEVELS.boa, 0)} (R$ ${num(s.epoch.sma250 * (1 + LEVELS.boa))})`,
    level ? (next ? `Próximo: ${next}` : "Já é o nível mais alto") : undefined,
    ...(wise ? ["", wise] : []),
    ...section("Para comparar", comparisonLines(s)),
    ...section("Fique de olho", contextLines(s, v.today)),
    ...section(
      "Faixa provável (68%)",
      [w, m]
        .filter((b) => b !== undefined)
        .map((b) => `${b.days === 5 ? "1 semana" : "1 mês"}: R$ ${num(b.low68)} a ${num(b.high68)}`),
    ),
    "",
    `Score de curto prazo: ${Math.round(s.score.score)}/100`,
    `<i>Atualizado às ${hhmm(v.updated.hour, v.updated.minute)} (${v.updated.source})</i>`,
  ]);
}

export interface EpochRow {
  start: string;
  end: string | null;
  entryPrice: number;
  minPrice: number;
  minDist: number;
  minDate: string;
  maxLevel: Level;
}

/** /epoca: a época atual (ou há quanto tempo terminou a última) e as anteriores. */
export function renderEpochs(v: {
  today: string;
  price: number;
  dist250: number;
  epochs: EpochRow[];
}): string {
  const [current, ...rest] = v.epochs;
  const open = current && current.end === null ? current : undefined;
  const past = (open ? rest : v.epochs).slice(0, 5);
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const head = open
    ? [
        `${LEVEL_ICON[open.maxLevel]} <b>Boa época ativa</b>`,
        "",
        `Desde ${ddmm(open.start)} (há ${days(open.start, v.today)} dias) · nível <b>${LEVEL_NAME[open.maxLevel]}</b>`,
        `Começou a R$ ${rate(open.entryPrice)} · hoje R$ ${rate(v.price)} (${pct(v.price / open.entryPrice - 1, 1, true)})`,
        `Mais baixo: R$ ${rate(open.minPrice)} (${pct(open.minDist, 1, true)}) em ${ddmm(open.minDate)}`,
      ]
    : [
        "⚪ <b>Fora de boa época</b>",
        "",
        `Hoje: ${vs12m(v.dist250)}`,
        past[0]?.end
          ? `A última terminou em ${ddmm(past[0].end)} (há ${days(past[0].end, v.today)} dias)`
          : undefined,
      ];
  return esc([
    ...head,
    ...section(
      "Épocas anteriores",
      past.map(
        (e) =>
          `${ddmm(e.start)}/${e.start.slice(2, 4)} a ${e.end ? ddmm(e.end) : "hoje"} · ${LEVEL_NAME[e.maxLevel]} · ` +
          `mínimo ${pct(e.minDist, 1, true)}`,
      ),
    ),
  ]);
}

function scoreBlock(title: string, s: ScoreSummary): string[] {
  if (s.measured === 0)
    return section(title, [`${s.epochs} épocas, nenhuma com os 3 meses seguintes completos ainda`]);
  return section(`${title} (${s.epochs} épocas)`, [
    `Começo abaixo da média dos 3 meses seguintes: ${pct(s.hitRate, 0)} das vezes`,
    `Começo vs média dos 3 meses seguintes: ${pct(s.vsNext3m, 1, true)} em média`,
    `Depois do começo, o euro ainda caiu: ${pct(Math.abs(s.furtherDrop))} em média`,
  ]);
}

/** /placar: como as boas épocas se saíram. */
export function renderScore(v: { year: ScoreSummary; fiveYears: ScoreSummary; all: ScoreSummary }): string {
  return esc([
    "📊 <b>Placar das boas épocas</b>",
    "",
    "Compara o preço no começo de cada época com o que veio depois.",
    ...scoreBlock("Último ano", v.year),
    ...scoreBlock("Últimos 5 anos", v.fiveYears),
    ...scoreBlock("Desde 2002", v.all),
    "",
    "<i>Negativo no segundo item = o começo foi um preço bom. O placar da IA entra junto com a IA.</i>",
  ]);
}

export interface StatusView {
  lastTick?: { hour: number; minute: number; minutesAgo: number; source?: string };
  ticksToday: number;
  maintenance?: { hour: number; minute: number; failed: string[] };
  alertsToday: { sent: number; held: number };
  muteUntil?: { date: string; hour: number; minute: number };
  dryRun: boolean;
  incidentSince?: { hour: number; minute: number };
}

/** /status: saúde do sistema. */
export function renderStatus(v: StatusView): string {
  return esc([
    "🩺 <b>Status</b>",
    "",
    v.lastTick
      ? `Última coleta: ${hhmm(v.lastTick.hour, v.lastTick.minute)} (há ${v.lastTick.minutesAgo} min)` +
        (v.lastTick.source ? ` · ${v.lastTick.source}` : "")
      : "Última coleta: nenhuma ainda",
    `Coletas hoje: ${v.ticksToday}`,
    v.maintenance
      ? `Manutenção: ${hhmm(v.maintenance.hour, v.maintenance.minute)} · ${
          v.maintenance.failed.length ? `falhou: ${v.maintenance.failed.join(", ")}` : "sem falhas"
        }`
      : "Manutenção: ainda não rodou",
    `Alertas hoje: ${v.alertsToday.sent} enviados · ${v.alertsToday.held} retidos`,
    v.muteUntil
      ? `🔕 Silenciado até ${ddmm(v.muteUntil.date)} ${hhmm(v.muteUntil.hour, v.muteUntil.minute)}`
      : "🔔 Alertas ligados",
    v.dryRun ? "🧪 Modo silencioso ligado (alertas só registrados)" : undefined,
    v.incidentSince
      ? `⚠️ Coleta com problema desde ${hhmm(v.incidentSince.hour, v.incidentSince.minute)}`
      : undefined,
  ]);
}

export const HELP = esc([
  "🤖 <b>Comandos</b>",
  "",
  "/agora · o euro agora: preço, nível, comparações e custo na Wise",
  "/epoca · a boa época atual e as anteriores",
  "/grafico · gráfico (90d, 1a ou 5a; padrão 1a)",
  "/placar · como as boas épocas se saíram",
  "/pausar · silencia os alertas (ex.: /pausar 3d ou /pausar 12h; padrão 24h)",
  "/retomar · volta a avisar",
  "/alertas · liga e desliga os alertas opcionais",
  "/status · saúde do sistema",
  "/analise · comentário da IA (em breve)",
  "/ajuda · esta lista",
]);

export interface WeeklyView {
  week: number;
  price: number;
  weekChange?: number;
  dist250: number;
  epoch?: { start: string; level: Level };
  year: ScoreSummary;
  ticks: { done: number; expected: number; wisePct: number };
  alerts: { sent: number; held: number };
  maintenanceFailed: string[];
}

/** Relatório de sexta 18h. */
export function renderWeekly(v: WeeklyView): string {
  return esc([
    `📊 <b>Semana ${v.week}</b>`,
    "",
    priceLine(v.price) + (v.weekChange !== undefined ? ` · ${pct(v.weekChange, 1, true)} na semana` : ""),
    vs12m(v.dist250),
    v.epoch
      ? `Boa época ativa desde ${ddmm(v.epoch.start)} (nível ${LEVEL_NAME[v.epoch.level]})`
      : "Fora de boa época",
    ...section(
      `Placar do último ano (${v.year.epochs} épocas)`,
      v.year.measured
        ? [
            `Começo abaixo da média dos 3 meses seguintes: ${pct(v.year.hitRate, 0)} das vezes`,
            `Depois do começo, o euro ainda caiu: ${pct(Math.abs(v.year.furtherDrop))} em média`,
          ]
        : ["Ainda sem épocas com os 3 meses seguintes completos"],
    ),
    ...section("Sistema", [
      `Coletas: ${v.ticks.done} de ${v.ticks.expected} · Wise em ${pct(v.ticks.wisePct, 0)}`,
      `Alertas: ${v.alerts.sent} enviados · ${v.alerts.held} retidos`,
      `Última manutenção: ${v.maintenanceFailed.length ? `falhou: ${v.maintenanceFailed.join(", ")}` : "sem falhas"}`,
    ]),
  ]);
}
