-- Migration number: 0003 · placar da tendência de 7 dias da IA

-- Preço do primeiro fechamento 7 dias depois da previsão (a IA fala dos próximos 7 dias)
ALTER TABLE predictions ADD COLUMN price_7d REAL;
