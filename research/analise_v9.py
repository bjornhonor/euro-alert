"""V9: "boa época" combinando desconto (preço abaixo da média de 12 meses) com o contexto de tendência.
Pergunta: separar desconto temporário (tendência de longo prazo ainda de alta) de tendência de queda
melhora a qualidade do sinal?"""
import numpy as np
import pandas as pd

from analise_preliminar import load_ecb, load_wise_daily
from analise_v8 import base


def add_trend(df):
    s = df.p
    sma250 = s.rolling(250).mean()
    df = df.copy()
    df["slope250"] = sma250 / sma250.shift(63) - 1      # média de 12 meses subindo ou caindo nos últimos 3 meses
    df["acima_sma20"] = s > s.rolling(20).mean()
    df["acima_sma50"] = s > s.rolling(50).mean()
    df["ret20"] = s / s.shift(20) - 1
    return df


def quality(df, label, min_days=40):
    d = df.dropna(subset=["vs_prox12m", "slope250"])
    base_m = d.index == d.index
    rows = [
        ("todos os dias", base_m),
        ("A) distância ≤ −3%", (d.dist <= -0.03).values),
        ("B) A + preço acima da média de 20 dias", ((d.dist <= -0.03) & d.acima_sma20).values),
        ("C) A + preço acima da média de 50 dias", ((d.dist <= -0.03) & d.acima_sma50).values),
        ("D) A + média de 12 meses subindo", ((d.dist <= -0.03) & (d.slope250 > 0)).values),
        ("E) A + média de 12 meses caindo", ((d.dist <= -0.03) & (d.slope250 <= 0)).values),
        ("F) D + acima da média de 20 dias", ((d.dist <= -0.03) & (d.slope250 > 0) & d.acima_sma20).values),
        ("G) E + acima da média de 50 dias", ((d.dist <= -0.03) & (d.slope250 <= 0) & d.acima_sma50).values),
    ]
    u6, u12 = d.vs_prox6m.mean() * 100, d.vs_prox12m.mean() * 100
    print(f"\n=== {label} ({d.index[0].date()} a {d.index[-1].date()}): preço vs média dos meses seguintes, "
          f"descontando o que um dia qualquer consegue (todos os dias: {u6:+.1f}% em 6m, {u12:+.1f}% em 12m)")
    print(f"{'filtro':42s} {'vs 6m':>7s} {'% abaixo':>8s} {'vs 12m':>7s} {'% abaixo':>8s} {'dias':>6s} {'% dos dias':>10s}")
    for name, m in rows:
        if m.sum() < min_days:
            print(f"{name:42s} (menos de {min_days} dias)")
            continue
        x6, x12 = d.vs_prox6m[m] * 100, d.vs_prox12m[m] * 100
        print(f"{name:42s} {x6.mean()-u6:+6.1f}% {100*(x6<0).mean():7.0f}% {x12.mean()-u12:+6.1f}% {100*(x12<0).mean():7.0f}% "
              f"{m.sum():6d} {100*m.mean():9.1f}%")


def by_subperiod(df):
    d = df.dropna(subset=["vs_prox12m", "slope250"])
    print("\n=== Filtro D (desconto com média de 12 meses subindo) por período, vs todos os dias do mesmo período (6 meses)")
    for a, b in (("2003", "2008"), ("2009", "2014"), ("2015", "2020"), ("2021", "2025")):
        x = d.loc[a:b]
        u = x.vs_prox6m.mean() * 100
        for name, m in (("A", x.dist <= -0.03), ("D", (x.dist <= -0.03) & (x.slope250 > 0)), ("E", (x.dist <= -0.03) & (x.slope250 <= 0))):
            v = x.vs_prox6m[m] * 100
            txt = f"{v.mean()-u:+5.1f}% ({m.sum()} dias)" if m.sum() >= 20 else "  —  "
            print(f"  {a}-{b} {name}: {txt}", end="")
        print()


def now(df, label):
    last = df.iloc[-1]
    print(f"\n=== Hoje ({label}, {df.index[-1].date()}): distância {100*last.dist:+.1f}%, média de 12 meses "
          f"{'subindo' if last.slope250 > 0 else 'caindo'} ({100*last.slope250:+.1f}% em 3 meses), "
          f"preço {'acima' if last.acima_sma20 else 'abaixo'} da média de 20 dias e "
          f"{'acima' if last.acima_sma50 else 'abaixo'} da de 50 dias")


if __name__ == "__main__":
    ecb = add_trend(base(load_ecb()))
    wise = add_trend(base(load_wise_daily()))
    quality(ecb, "BCE")
    quality(wise, "Wise", min_days=15)
    by_subperiod(ecb)
    now(ecb, "BCE")
    now(wise, "Wise")
