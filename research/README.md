# research

Análise preliminar que embasou a estratégia de compra descrita em `docs/PLANO.md` (seção 3 e apêndice A).
É a referência em Python para os testes "golden" dos indicadores (Etapa 3) e para validar o backtest em TypeScript (Etapa 5).

## Como rodar

```bash
pip install numpy pandas
python research/analise_preliminar.py --sanity
python research/analise_v2.py
python research/analise_v3.py
python research/analise_v4.py
```

| Script | O que faz |
|---|---|
| `analise_preliminar.py` | estatísticas do EUR/BRL (volatilidade, autocorrelação, variance ratio), retorno futuro por faixa de score, estratégia de fatias com intervalo, placebo e teste com passeio aleatório (`--sanity`) |
| `analise_v2.py` | inclui o rendimento do CDI enquanto o dinheiro espera; limiar decrescente; oráculo (teto teórico) |
| `analise_v3.py` | variantes da ideia original (antecipação, compra parcial) e sensibilidade ao orçamento |
| `analise_v4.py` | limiar convexo e regra "só dia excepcional, senão fechamento" |
| `analise_v5.py` | dinheiro parado na conta (sem CDI): regra agressiva no mês inteiro vs janela curta, filtros de regime e horário do dia (Yahoo 1h) |
| `analise_v6.py` | "boas épocas": sazonalidade por mês, câmbio em volta das eleições, acumular a caixa e comprar abaixo da média de 12 meses (parado e com CDI) |
| `analise_v7.py` | robustez da boa época (limiar de 2% a 5% x prazo de 4 a 9 meses) e variante sem compras em dezembro |
| `analise_v8.py` | boa época como alerta (sem dinheiro): distribuição, episódios com histerese, qualidade contra a média dos meses seguintes |
| `analise_v9.py` | boa época com filtros de tendência (médias de 20 e 50 dias, inclinação da média de 12 meses), por período |
| `analise_v10.py` | contexto de 5 anos e câmbio real (corrigido pela inflação) contra a história; épocas que chegam a −5% e −8% |

## Dados (`data/`, baixados em 23/09/2026)

| Arquivo | Origem |
|---|---|
| `ecb_eurbrl.json` | BCE via Frankfurter, EUR/BRL diário desde 2002 |
| `wise_daily5y.json`, `wise_hourly30d.json` | Wise `history+live` (5 anos diário, 30 dias por hora) |
| `cdi_2002.json`, `cdi_2012.json`, `cdi_2022.json` | BCB SGS série 12 (CDI, % ao dia) |
| `cmp_<valor>.json` | Wise `/v3/comparisons` BRL→EUR para R$ 100, 300, 1.000, 3.000 e 10.000 |
| `yahoo_eurbrl_1h.csv` | Yahoo Finance `EURBRL=X` por hora (dez/2023 a set/2026), não oficial |
| `ipca_433.json` | BCB SGS série 433 (IPCA, variação mensal) desde 2002 |
| `hicp_ea.json` | Eurostat `prc_hicp_midx`, inflação harmonizada da zona do euro (2015=100), dez/2001 a dez/2025 |
| `awesome_last.json`, `sgs_432*.json`, `focus_cambio.json`, `ff_week.json` | amostras de resposta para fixtures |

Premissas da simulação: compra pelo preço diário da série; tarifa = R$ 2,18 + 3,975% do valor; orçamento chega no 1º dia útil do mês e rende CDI com IR de 22,5% até a compra. Em `analise_v5.py` o dinheiro do euro fica parado (sem CDI), e a referência passa a ser comprar no dia em que ele cai.
