-- Migration number: 0002 · indicadores (Etapa 3)

-- Preço ÷ K(mês), com K = índice IPCA ÷ índice de inflação da zona do euro. Permite calcular o
-- câmbio real contra a história sem reler a série inteira (ver src/engine/real-rate.ts).
ALTER TABLE daily_close ADD COLUMN deflated REAL;
CREATE INDEX idx_daily_close_deflated ON daily_close (pair, deflated);

-- Nível instantâneo da boa época ('boa' | 'muito_boa' | 'rara' | NULL) e o resto do contexto
-- (projeção, decomposição, sazonalidade, médias) em JSON.
ALTER TABLE signals ADD COLUMN level TEXT;
ALTER TABLE signals ADD COLUMN extra TEXT;
