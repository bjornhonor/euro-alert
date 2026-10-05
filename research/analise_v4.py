"""V4: limiar convexo (fica exigente até perto do fim da janela) e 'só dia excepcional,
senão compra no fim' — tenta capturar timing sem perder o CDI de esperar."""
import numpy as np

from analise_preliminar import indicators, load_ecb, load_wise_daily, months
from analise_v2 import (dca_monthly, dca_monthly_end, declining_threshold, evaluate,
                        load_cdi_index, placebo_windows, windows)


def convex_threshold(df, budget, w, tau_max, power):
    """Limiar tau(k) = tau_max * (1 - (k/(n-1))^power): alto por mais tempo, cai no fim."""
    buys = []
    for g in months(df):
        for c in windows(g, w):
            n = len(c)
            for k, i in enumerate(c):
                tau = tau_max * (1 - (k / (n - 1)) ** power) if n > 1 else 0
                if k == n - 1 or g.score.iloc[i] >= tau:
                    buys.append((g.index[i], budget / w, g.p.iloc[i]))
                    break
    return buys


def block(df, label, C, budget=1200.0):
    nm = len(months(df))
    ms = {per: g.index[0] for per, g in df.groupby(df.index.to_period("M"))}
    q95, q98, q99 = df.score.quantile([0.95, 0.98, 0.99]).values
    strat = {
        "DCA mensal (1º dia útil)": (dca_monthly(df, budget), None),
        "DCA mensal (último dia útil)": (dca_monthly_end(df, budget), None),
        "Limiar linear, 1/mês": (declining_threshold(df, budget, 1, q95), 1),
        "Limiar convexo p=3, 1/mês": (convex_threshold(df, budget, 1, q95, 3), 1),
        "Limiar convexo p=6, 1/mês": (convex_threshold(df, budget, 1, q95, 6), 1),
        "Só excepcional (top 2%), senão fim": (convex_threshold(df, budget, 1, q98, 1e9), 1),
        "Só excepcional (top 1%), senão fim": (convex_threshold(df, budget, 1, q99, 1e9), 1),
        "Limiar convexo p=3, 2/mês": (convex_threshold(df, budget, 2, q95, 3), 2),
    }
    ev = {n: evaluate(b, C, ms) for n, (b, _) in strat.items()}
    base = ev["DCA mensal (1º dia útil)"]
    end = ev["DCA mensal (último dia útil)"]
    print(f"\n=== {label} | R${budget:.0f}/mês | limiares top5/2/1%: {q95:.1f}/{q98:.1f}/{q99:.1f}")
    print(f"{'estratégia':36s} {'ops/mês':>7s} {'timing':>8s} {'c/tarifa+CDI':>12s} {'vs DCA fim':>10s} {'placebo p':>9s}")
    for n, e in ev.items():
        b, w = strat[n]
        pv = ""
        if w:
            pl = placebo_windows(df, b, w, n=300)
            pv = f"{(pl <= e['mid']).mean():.3f}"
        print(f"{n:36s} {e['ops']/nm:7.1f} {100*(base['mid']-e['mid'])/base['mid']:+8.2f}% "
              f"{100*(base['efetivo_cdi']-e['efetivo_cdi'])/base['efetivo_cdi']:+11.2f}% "
              f"{100*(end['efetivo_cdi']-e['efetivo_cdi'])/end['efetivo_cdi']:+9.2f}% {pv:>9s}")


if __name__ == "__main__":
    C = load_cdi_index()
    ecb = indicators(load_ecb())
    block(ecb, "BCE 24 anos", C)
    block(ecb[ecb.index >= "2016-01-01"], "BCE 10 anos", C)
    block(indicators(load_wise_daily()), "Wise diário 2022-2026", C)
