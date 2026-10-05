"""V6: "boas épocas" para comprar, sem obrigação de comprar todo mês.
A) sazonalidade por mês do ano; B) câmbio em volta das eleições; C) acumular o dinheiro do euro
e comprar só quando o euro está barato em relação à média longa (com prazo máximo de espera),
com o dinheiro parado ou rendendo CDI enquanto espera."""
import numpy as np
import pandas as pd

from analise_preliminar import FIX, VAR, load_ecb, load_wise_daily
from analise_v2 import load_cdi_index

E = 500.0          # valor mensal de exemplo
T_MIN = 400.0


def fee(a):
    return FIX + VAR * a


def ir(days):
    return 0.225 if days <= 180 else 0.20 if days <= 360 else 0.175 if days <= 720 else 0.15


def add_signals(s):
    df = pd.DataFrame({"p": s})
    sma = s.rolling(250).mean()
    df["dist250"] = s / sma - 1
    df["z250"] = (s - sma) / s.rolling(250).std()
    df["pct756"] = s.rolling(756).rank(pct=True)
    return df


# ---------------------------------------------------------------- A) sazonalidade
def seasonality(s):
    m = s.groupby(s.index.to_period("M")).mean()
    trend = m.rolling(12, center=True).mean().rolling(2).mean().shift(-1)  # média móvel 2x12 centrada
    ratio = (m / trend - 1).dropna() * 100
    tab = ratio.groupby(ratio.index.month).agg(["mean", "std", "count"])
    tab["erro_padrao"] = tab["std"] / np.sqrt(tab["count"])
    print("\n=== A) Sazonalidade: preço médio de cada mês vs tendência de 12 meses (%, negativo = mais barato)")
    names = "jan fev mar abr mai jun jul ago set out nov dez".split()
    for mo, row in tab.iterrows():
        print(f"{names[mo-1]}  {row['mean']:+.2f}%  ± {row['erro_padrao']:.2f}  ({int(row['count'])} anos)")
    # walk-forward: escolhe o mês mais barato só com anos anteriores e mede no ano seguinte
    gains = []
    for y in range(2008, 2026):
        past = ratio[ratio.index.year < y]
        best = past.groupby(past.index.month).mean().idxmin()
        yr = m[m.index.year == y]
        gains.append(100 * (yr.mean() - yr[yr.index.month == best].iloc[0]) / yr.mean())
    g = np.array(gains)
    print(f"walk-forward (2008-2025): comprar no 'mês mais barato' estimado com os anos anteriores rendeu "
          f"{g.mean():+.2f}% em média vs a média do ano; anos positivos {100*(g>0).mean():.0f}%")


# ---------------------------------------------------------------- B) eleições
def elections(s):
    dates = ["2002-10-06", "2006-10-01", "2010-10-03", "2014-10-05", "2018-10-07", "2022-10-02"]
    print("\n=== B) EUR/BRL em volta do 1º turno das eleições presidenciais")
    print("ano  | 90 dias antes → eleição | eleição → 90 dias depois | máx. nos 90 dias antes vs 90 dias antes")
    pre_l, post_l = [], []
    for d in dates:
        t = pd.Timestamp(d)
        p0 = s.asof(t - pd.Timedelta(days=90)); pe = s.asof(t); p1 = s.asof(t + pd.Timedelta(days=90))
        mx = s[(s.index >= t - pd.Timedelta(days=90)) & (s.index <= t)].max()
        pre, post = 100 * (pe / p0 - 1), 100 * (p1 / pe - 1)
        pre_l.append(pre); post_l.append(post)
        print(f"{d[:4]} | {pre:+6.1f}% | {post:+6.1f}% | {100*(mx/p0-1):+6.1f}%")
    print(f"média | {np.mean(pre_l):+6.1f}% | {np.mean(post_l):+6.1f}% |  (mediana: {np.median(pre_l):+.1f}% antes, {np.median(post_l):+.1f}% depois)")


# ---------------------------------------------------------------- C) acumular e comprar em boa época
def simulate(df, C, mode, rule, start, end, **kw):
    d = df[(df.index >= start) & (df.index <= end)]
    firsts = set(d.groupby(d.index.to_period("M")).head(1).index)
    lots, total_in, eur, buys = [], 0.0, 0.0, []
    last_buy_month = d.index[0].to_period("M") - 1
    last_buy_i = -10**9
    per_month = {}
    for i, (t, row) in enumerate(d.iterrows()):
        per = t.to_period("M")
        if t in firsts:
            lots.append((E, t)); total_in += E
        if not lots:
            continue
        if mode == "cdi":
            cash = sum(a * (1 + (C.asof(t) / C.asof(t0) - 1) * (1 - ir((t - t0).days))) for a, t0 in lots)
        else:
            cash = sum(a for a, _ in lots)
        months_waiting = (per - last_buy_month).n
        buy = rule(t, i, row, per, months_waiting, t in firsts, i - last_buy_i, **kw)
        if buy and cash >= T_MIN:
            eur += (cash - fee(cash)) / row.p
            buys.append((t, cash, months_waiting))
            lots, last_buy_month, last_buy_i = [], per, i
    if lots:  # sobra no fim da amostra: converte pelo último preço
        t = d.index[-1]
        cash = sum(a for a, _ in lots) if mode != "cdi" else sum(
            a * (1 + (C.asof(t) / C.asof(t0) - 1) * (1 - ir((t - t0).days))) for a, t0 in lots)
        eur += (cash - fee(cash)) / d.p.iloc[-1]
    years = (d.index[-1] - d.index[0]).days / 365.25
    return {"preco": total_in / eur, "compras_ano": len(buys) / years,
            "ticket": np.mean([b[1] for b in buys]) if buys else 0,
            "max_espera": max([b[2] for b in buys]) if buys else 0}


def r_monthly(t, i, row, per, mw, is_first, gap):
    return is_first


def r_every(t, i, row, per, mw, is_first, gap, k):
    return is_first and mw >= k


def r_signal(t, i, row, per, mw, is_first, gap, col, thr, mmax):
    if is_first and mw >= mmax:                   # prazo máximo: compra de qualquer jeito
        return True
    return gap >= 20 and row[col] <= thr          # boa época


def block_c(df, C, start, end, label):
    base_rules = [
        ("Todo mês, quando o dinheiro cai", r_monthly, {}),
        ("A cada 3 meses, data fixa", r_every, {"k": 3}),
        ("A cada 6 meses, data fixa", r_every, {"k": 6}),
        ("Boa época: abaixo da média de 1 ano (máx. 6 meses)", r_signal, {"col": "dist250", "thr": 0.0, "mmax": 6}),
        ("Boa época: 3% abaixo da média de 1 ano (máx. 6 meses)", r_signal, {"col": "dist250", "thr": -0.03, "mmax": 6}),
        ("Boa época: percentil 3 anos ≤ 30% (máx. 6 meses)", r_signal, {"col": "pct756", "thr": 0.30, "mmax": 6}),
        ("Boa época: abaixo da média de 1 ano (máx. 12 meses)", r_signal, {"col": "dist250", "thr": 0.0, "mmax": 12}),
        ("Boa época: abaixo da média de 1 ano (máx. 3 meses)", r_signal, {"col": "dist250", "thr": 0.0, "mmax": 3}),
    ]
    for mode in ("parado", "cdi"):
        res = [(n, simulate(df, C, mode, r, start, end, **kw)) for n, r, kw in base_rules]
        b = res[0][1]["preco"]
        print(f"\n=== C) {label} | dinheiro {'parado' if mode == 'parado' else 'rendendo CDI enquanto espera'} | R${E:.0f}/mês")
        print(f"{'regra':56s} {'vs todo mês':>11s} {'compras/ano':>11s} {'ticket médio':>12s} {'máx. espera':>11s}")
        for n, r in res:
            print(f"{n:56s} {100*(b-r['preco'])/b:+10.2f}% {r['compras_ano']:11.1f} {r['ticket']:11.0f} {r['max_espera']:9d} m")


if __name__ == "__main__":
    s = load_ecb()
    C = load_cdi_index()
    df = add_signals(s)
    seasonality(s)
    elections(s)
    for start, end, label in [("2005-01-01", "2026-09-23", "2005-2026"),
                              ("2016-01-01", "2021-12-31", "2016-2021 (real em queda)"),
                              ("2022-01-01", "2026-09-23", "2022-2026 (câmbio de lado)")]:
        block_c(df, C, start, end, label)
    w = add_signals(load_wise_daily())
    last = df.iloc[-1]
    print(f"\n=== Hoje ({df.index[-1].date()}, BCE {last.p:.4f}): {100*last.dist250:+.1f}% vs média de 1 ano "
          f"(média {last.p/(1+last.dist250):.4f}), z = {last.z250:+.2f}, percentil de 3 anos = {100*last.pct756:.0f}%")
