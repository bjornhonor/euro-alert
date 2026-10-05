-- Migration number: 0001 · schema inicial (docs/PLANO.md, seção 6)

-- Cotações a cada 15 min. A manutenção apaga o que tiver mais de 90 dias:
-- o histórico longo vem das fontes públicas
CREATE TABLE rates (
  pair    TEXT    NOT NULL,              -- 'EURBRL' | 'USDBRL' | 'EURUSD'
  ts      INTEGER NOT NULL,              -- epoch ms UTC, arredondado a 15 min
  mid     REAL    NOT NULL,
  bid     REAL,
  ask     REAL,
  source  TEXT    NOT NULL,              -- 'wise-api' | 'wise-public' | 'awesomeapi'
  PRIMARY KEY (pair, ts)
);

-- Fechamento diário: BCE até 22/09/2021, Wise daí em diante, dados próprios depois do go-live
CREATE TABLE daily_close (
  pair    TEXT NOT NULL,
  date    TEXT NOT NULL,                 -- 'YYYY-MM-DD' (Brasília)
  close   REAL NOT NULL,
  source  TEXT NOT NULL,                 -- 'ecb' | 'wise' | 'own'
  PRIMARY KEY (pair, date)
);

-- Indicadores calculados a cada execução
CREATE TABLE signals (
  ts          INTEGER PRIMARY KEY,
  price       REAL NOT NULL,
  dist250     REAL NOT NULL,             -- distância da média de 12 meses (gatilho)
  pct250      REAL NOT NULL,             -- % dos dias dos últimos 12 meses mais caros que hoje
  dist1260    REAL NOT NULL,             -- distância da média de 5 anos
  pct1260     REAL NOT NULL,             -- % dos dias dos últimos 5 anos mais caros que hoje
  real_dist   REAL NOT NULL,             -- câmbio real vs média desde 2002
  real_pct    REAL NOT NULL,             -- % dos dias desde 2002 mais caros que hoje, em reais de hoje
  slope250    REAL NOT NULL,             -- variação da média de 12 meses em 3 meses
  above_sma20 INTEGER NOT NULL,
  above_sma50 INTEGER NOT NULL,
  score       REAL NOT NULL,
  components  TEXT NOT NULL              -- JSON do score
);

-- Episódios de boa época
CREATE TABLE epochs (
  id           INTEGER PRIMARY KEY,
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER,                  -- NULL enquanto estiver ativa
  entry_price  REAL NOT NULL,
  min_price    REAL NOT NULL,
  min_dist     REAL NOT NULL,
  min_ts       INTEGER NOT NULL,
  max_level    TEXT NOT NULL,            -- 'boa' | 'muito_boa' | 'rara'
  source       TEXT NOT NULL             -- 'live' | 'backfill'
);

-- Alertas enviados
CREATE TABLE alerts (
  id             INTEGER PRIMARY KEY,
  ts             INTEGER NOT NULL,
  kind           TEXT NOT NULL,          -- 'epoca_inicio' | 'epoca_nivel' | 'epoca_fim' | 'excepcional'
                                         -- | 'disparada' | 'evento' | 'sazonal' | 'sistema'
  level          TEXT,
  price          REAL,
  dist250        REAL,
  epoch_id       INTEGER REFERENCES epochs(id),
  context        TEXT,                   -- JSON do bloco de contexto
  tg_message_id  INTEGER,
  ai_comment     TEXT,
  delivered      INTEGER NOT NULL        -- 0 se caiu no silêncio e foi para o resumo
);

-- Placar dos alertas de boa época
CREATE TABLE alert_outcomes (
  alert_id    INTEGER PRIMARY KEY REFERENCES alerts(id),
  avg_1m      REAL,                      -- média do preço nos 21 dias úteis seguintes
  avg_3m      REAL,                      -- 63 dias úteis
  avg_6m      REAL,                      -- 126 dias úteis
  min_3m      REAL,                      -- mínimo nos 3 meses seguintes
  updated     INTEGER NOT NULL
);

-- Curva de tarifa da Wise (custo real no alerta)
CREATE TABLE fee_quotes (
  ts            INTEGER NOT NULL,
  amount_brl    REAL NOT NULL,
  fee_brl       REAL NOT NULL,
  rate          REAL NOT NULL,           -- EUR por BRL
  received_eur  REAL NOT NULL,
  PRIMARY KEY (ts, amount_brl)
);

-- Selic, CDI, juro do BCE, Focus…
CREATE TABLE macro_series (
  series  TEXT NOT NULL,
  date    TEXT NOT NULL,
  value   REAL NOT NULL,
  PRIMARY KEY (series, date)
);

CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  ts       INTEGER NOT NULL,
  country  TEXT NOT NULL,
  title    TEXT NOT NULL,
  impact   TEXT NOT NULL,                -- 'Low' | 'Medium' | 'High' | 'Holiday'
  source   TEXT NOT NULL,                -- 'forexfactory' | 'config'
  UNIQUE (ts, country, title)
);

CREATE TABLE macro_briefings (
  id        INTEGER PRIMARY KEY,
  date      TEXT NOT NULL UNIQUE,
  provider  TEXT NOT NULL,
  model     TEXT NOT NULL,
  bias      INTEGER,                     -- -2..+2 (positivo = euro tende a subir)
  summary   TEXT NOT NULL,
  data      TEXT NOT NULL,               -- JSON: fatores, cenários, eventos
  sources   TEXT NOT NULL,               -- JSON [{title, url}]
  raw       TEXT
);

-- Placar da IA
CREATE TABLE predictions (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,              -- 'leitura_alerta' | 'vies_macro'
  value      INTEGER NOT NULL,
  price_at   REAL NOT NULL,
  price_1m   REAL,
  price_3m   REAL,
  ref_id     INTEGER
);

CREATE TABLE ai_calls (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  task        TEXT NOT NULL,             -- 'alerta' | 'macro_1' | 'macro_2'
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  latency_ms  INTEGER,
  error       TEXT
);

CREATE TABLE config     (key TEXT PRIMARY KEY, value TEXT NOT NULL);                          -- JSON
CREATE TABLE state      (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE tg_updates (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);                -- idempotência

CREATE INDEX idx_alerts_ts      ON alerts (ts);
CREATE INDEX idx_epochs_start   ON epochs (start_ts);
CREATE INDEX idx_events_ts      ON events (ts);
CREATE INDEX idx_predictions_ts ON predictions (kind, ts);
CREATE INDEX idx_ai_calls_ts    ON ai_calls (ts);
