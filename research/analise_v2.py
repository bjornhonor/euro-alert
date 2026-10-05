"""V2: inclui o rendimento do CDI enquanto o dinheiro espera e testa estratégias com
poucas compras por janela (limiar decrescente), placebo e oráculo (teto teórico)."""
import json

import numpy as np
import pandas as pd

from analise_preliminar import (D, FIX, VAR, RNG, dca_monthly, dca_weekly, indicators,
                                load_ecb, load_wise_daily, months, tiered)

IR = 0.225  # IR sobre o rendimento de curto prazo


def load_cdi_index():
    rows = []
    for y in ("2002", "2012", "2022"):
        rows += json.load(open(D / f"cdi_{y}.json"))
    s = pd.Series({pd.to_datetime(r["data"], dayfirst=True): float(r["valor"]) for r in rows}).sort_index()
    return (1 + s / 100).cumprod()


def windows(g, w):
    """Divide os dias úteis do mês em w janelas contíguas."""
    return [c for c in np.array_split(np.arange(len(g)), w) if len(c)]


def dca_monthly_end(df, budget):
    return [(g.index[-1], budget, g.p.iloc[-1]) for g in months(df)]


def declining_threshold(df, budget, w, tau_max):
    """Em cada janela: compra tudo no 1º dia em que score >= limiar; limiar cai até 0 no fim."""
    buys = []
    for g in months(df):
        for c in windows(g, w):
            n = len(c)
            for k, i in enumerate(c):
                tau = tau_max * (1 - k / (n - 1)) if n > 1 else 0
                if g.score.iloc[i] >= tau:
                    buys.append((g.index[i], budget / w, g.p.iloc[i]))
                    break
    return buys


def weekly_symmetric(df, budget):
    """Toda semana compra base x (0.5 + score/100); a última semana fecha o orçamento."""
    buys = []
    for g in months(df):
        wk = g.groupby(g.index.isocalendar().week.values).head(1)
        base, left = budget / len(wk), budget
        for j, (d, row) in enumerate(wk.iterrows()):
            a = left if j == len(wk) - 1 else min(left, base * (0.5 + row.score / 100))
            if a > 1e-9:
                buys.append((d, a, row.p)); left -= a
    return buys


def oracle(df, budget, w):
    """Teto teórico: compra no dia mais barato de cada janela (olhando o futuro)."""
    buys = []
    for g in months(df):
        for c in windows(g, w):
            i = c[np.argmin(g.p.values[c])]
            buys.append((g.index[i], budget / w, g.p.iloc[i]))
    return buys


def placebo_windows(df, buys, w, n=400):
    """Mesmo valor por janela, em dia aleatório da janela."""
    grp = {per: g for per, g in df.groupby(df.index.to_period("M"))}
    per_month = {}
    for d, a, _ in buys:
        per_month.setdefault(d.to_period("M"), a)
    mids = []
    for _ in range(n):
        num = den = 0.0
        for per, a in per_month.items():
            g = grp[per]
            for c in windows(g, w):
                px = g.p.values[RNG.choice(c)]
                num += a; den += a / px
        mids.append(num / den)
    return np.array(mids)


def evaluate(buys, C, month_start):
    brl = np.array([b[1] for b in buys]); p = np.array([b[2] for b in buys])
    fee = FIX + VAR * brl
    grow = np.array([C.asof(d) / C.asof(month_start[d.to_period("M")]) for d, _, _ in buys])
    amt_c = brl * (1 + (grow - 1) * (1 - IR))
    fee_c = FIX + VAR * amt_c
    return {"ops": len(buys), "mid": brl.sum() / (brl / p).sum(),
            "efetivo": brl.sum() / ((brl - fee) / p).sum(),
            "efetivo_cdi": brl.sum() / ((amt_c - fee_c) / p).sum()}


def block(df, label, C, budget=1200.0):
    nm = len(months(df))
    month_start = {per: g.index[0] for per, g in df.groupby(df.index.to_period("M"))}
    tau = df.score.quantile(0.95)
    q = df.score.quantile([0.70, 0.85, 0.95]).values
    strat = {
        "DCA mensal (1º dia útil)": dca_monthly(df, budget),
        "DCA mensal (último dia útil)": dca_monthly_end(df, budget),
        "DCA semanal": dca_weekly(df, budget),
        "Fatias + intervalo 3d (sua ideia)": tiered(df, budget, q, (150, 225, 300), 3)[0],
        "Semanal simétrico (0,5x-1,5x)": weekly_symmetric(df, budget),
        "Limiar decrescente, 1 janela/mês": declining_threshold(df, budget, 1, tau),
        "Limiar decrescente, 2 janelas/mês": declining_threshold(df, budget, 2, tau),
        "Oráculo 1/mês (teto teórico)": oracle(df, budget, 1),
        "Oráculo 2/mês (teto teórico)": oracle(df, budget, 2),
    }
    ev = {k: evaluate(v, C, month_start) for k, v in strat.items()}
    base = ev["DCA mensal (1º dia útil)"]
    print(f"\n=== {label} ({df.index[0].date()} a {df.index[-1].date()}), R${budget:.0f}/mês, IR {IR:.1%} sobre CDI")
    print(f"{'estratégia':36s} {'ops/mês':>7s} {'timing':>8s} {'c/ tarifa':>9s} {'c/ tarifa+CDI':>13s}   (vantagem vs DCA mensal 1º dia; + = mais barato)")
    for k, e in ev.items():
        print(f"{k:36s} {e['ops']/nm:7.1f} {100*(base['mid']-e['mid'])/base['mid']:+8.2f}% "
              f"{100*(base['efetivo']-e['efetivo'])/base['efetivo']:+8.2f}% "
              f"{100*(base['efetivo_cdi']-e['efetivo_cdi'])/base['efetivo_cdi']:+12.2f}%")
    for w in (1, 2):
        k = f"Limiar decrescente, {w} janela{'s' if w > 1 else ''}/mês"
        pl = placebo_windows(df, strat[k], w)
        print(f"placebo [{k}]: vantagem de timing vs dia aleatório {100*(pl.mean()-ev[k]['mid'])/pl.mean():+.2f}%  "
              f"p≈{(pl <= ev[k]['mid']).mean():.3f}")


if __name__ == "__main__":
    C = load_cdi_index()
    ecb = indicators(load_ecb())
    block(ecb, "BCE 24 anos", C)
    block(ecb[ecb.index >= "2016-01-01"], "BCE 10 anos", C)
    block(indicators(load_wise_daily()), "Wise diário", C)
