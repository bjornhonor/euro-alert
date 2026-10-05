"""V3: variantes da ideia original dentro do formato de janelas (limiar decrescente):
antecipação em dia excelente, compra parcial em dia bom, e sensibilidade ao orçamento."""
import numpy as np
import pandas as pd

from analise_preliminar import indicators, load_ecb, load_wise_daily, months, tiered, dca_weekly
from analise_v2 import declining_threshold, dca_monthly, dca_monthly_end, evaluate, load_cdi_index, windows


def window_variant(df, budget, w, tau_max, th, mode, t_min=400, frac=0.5, antecipa=0.5, cooldown=3):
    """mode: 'antecipa' = em dia excelente compra saldo + parte da próxima janela;
             'parcial'  = em dia abaixo de 'ótimo' compra só uma fração do saldo e segue na janela."""
    buys, borrowed, last_pos = [], 0.0, -10**9
    pos = {d: i for i, d in enumerate(df.index)}
    for g in months(df):
        for c in windows(g, w):
            bal, borrowed, n = budget / w - borrowed, 0.0, len(c)
            for k, i in enumerate(c):
                d, s, p = g.index[i], g.score.iloc[i], g.p.iloc[i]
                if k == n - 1:
                    if bal > 1:
                        buys.append((d, bal, p)); last_pos = pos[d]
                    break
                if pos[d] - last_pos < cooldown or bal < t_min:
                    continue
                tau = tau_max * (1 - k / (n - 1))
                if s < tau:
                    continue
                if mode == "antecipa" and s >= th[2]:
                    extra = antecipa * budget / w
                    buys.append((d, bal + extra, p)); borrowed, bal = extra, 0.0
                elif mode == "parcial" and s < th[1]:
                    a = max(t_min, frac * bal)
                    a = bal if bal - a < t_min else a
                    buys.append((d, a, p)); bal -= a
                else:
                    buys.append((d, bal, p)); bal = 0.0
                last_pos = pos[d]
                if bal <= 1:
                    break
    return buys


def block(df, label, C, budget):
    nm = len(months(df))
    ms = {per: g.index[0] for per, g in df.groupby(df.index.to_period("M"))}
    tau = df.score.quantile(0.95)
    th = df.score.quantile([0.70, 0.85, 0.95]).values
    k = budget / 1200
    strat = {
        "DCA mensal (1º dia útil)": dca_monthly(df, budget),
        "DCA mensal (último dia útil)": dca_monthly_end(df, budget),
        "DCA semanal": dca_weekly(df, budget),
        "Sua ideia, fatias 150/225/300 x k": tiered(df, budget, th, (150 * k, 225 * k, 300 * k), 3)[0],
        "Sua ideia, fatias 400/600/800 x k": tiered(df, budget, th, (400 * k, 600 * k, 800 * k), 5)[0],
        "Limiar decrescente 2/mês": declining_threshold(df, budget, 2, tau),
        "  + antecipa 50% em excelente": window_variant(df, budget, 2, tau, th, "antecipa"),
        "  + parcial 50% em dia bom": window_variant(df, budget, 2, tau, th, "parcial"),
        "Limiar decrescente 4/mês": declining_threshold(df, budget, 4, tau),
    }
    ev = {n: evaluate(b, C, ms) for n, b in strat.items()}
    base = ev["DCA mensal (1º dia útil)"]
    print(f"\n=== {label} | orçamento R${budget:.0f}/mês")
    print(f"{'estratégia':36s} {'ops/mês':>7s} {'timing':>8s} {'c/ tarifa':>9s} {'c/ tarifa+CDI':>13s}")
    for n, e in ev.items():
        print(f"{n:36s} {e['ops']/nm:7.1f} {100*(base['mid']-e['mid'])/base['mid']:+8.2f}% "
              f"{100*(base['efetivo']-e['efetivo'])/base['efetivo']:+8.2f}% "
              f"{100*(base['efetivo_cdi']-e['efetivo_cdi'])/base['efetivo_cdi']:+12.2f}%")


if __name__ == "__main__":
    C = load_cdi_index()
    ecb = indicators(load_ecb())
    wise = indicators(load_wise_daily())
    for b in (1200.0, 3000.0):
        block(ecb, "BCE 24 anos", C, b)
        block(wise, "Wise diário 2022-2026", C, b)
