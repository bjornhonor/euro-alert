"""V8: o sinal de "boa época" como alerta (sem dinheiro envolvido).
Quantas vezes aparece, quanto dura, quão fundo vai e se o preço nesses períodos foi de fato
melhor do que nos meses seguintes. Define níveis e a histerese de entrada/saída dos alertas."""
import numpy as np
import pandas as pd

from analise_preliminar import indicators, load_ecb, load_wise_daily


def base(s):
    df = pd.DataFrame({"p": s})
    df["dist"] = s / s.rolling(250).mean() - 1
    fwd6 = s[::-1].rolling(126).mean()[::-1].shift(-1)     # média dos 6 meses seguintes
    fwd12 = s[::-1].rolling(250).mean()[::-1].shift(-1)    # média dos 12 meses seguintes
    df["vs_prox6m"] = s / fwd6 - 1
    df["vs_prox12m"] = s / fwd12 - 1
    return df.dropna(subset=["dist"])


def episodes(df, enter, exit_):
    on, eps, start = False, [], None
    for t, d in df.dist.items():
        if not on and d <= enter:
            on, start = True, t
        elif on and d >= exit_:
            on = False
            eps.append((start, t))
    if on:
        eps.append((start, None))
    return eps


def describe(df, label):
    print(f"\n=== {label}: {df.index[0].date()} a {df.index[-1].date()}")
    q = df.dist.quantile([0.05, 0.10, 0.20, 0.30, 0.50]) * 100
    print("distribuição da distância até a média de 12 meses: " +
          ", ".join(f"P{int(k*100)} {v:+.1f}%" for k, v in q.items()))
    for thr in (-0.03, -0.05, -0.08):
        print(f"  dias com distância ≤ {thr*100:+.0f}%: {100*(df.dist <= thr).mean():.1f}%")
    years = (df.index[-1] - df.index[0]).days / 365.25
    for enter, exit_ in ((-0.03, -0.03), (-0.03, -0.01), (-0.03, 0.0)):
        eps = episodes(df, enter, exit_)
        durs, depths = [], []
        for a, b in eps:
            seg = df.loc[a:b] if b is not None else df.loc[a:]
            durs.append(len(seg)); depths.append(seg.dist.min() * 100)
        print(f"  entra em {enter*100:+.0f}%, sai em {exit_*100:+.0f}%: {len(eps)} episódios ({len(eps)/years:.1f}/ano), "
              f"duração mediana {np.median(durs):.0f} dias úteis (máx {max(durs)}), "
              f"profundidade mediana {np.median(depths):.1f}% (pior {min(depths):.1f}%)")


def quality(df, label):
    d = df.dropna(subset=["vs_prox12m"])
    print(f"\n=== Qualidade do sinal ({label}): preço do dia vs média dos meses seguintes (negativo = comprou abaixo)")
    rows = [("todos os dias", d.index == d.index)]
    for thr in (-0.03, -0.05, -0.08):
        rows.append((f"distância ≤ {thr*100:+.0f}%", (d.dist <= thr).values))
    rows.append(("distância ≥ +3% (euro caro)", (d.dist >= 0.03).values))
    for name, m in rows:
        x6, x12 = d.vs_prox6m[m] * 100, d.vs_prox12m[m] * 100
        print(f"  {name:28s} vs 6 meses seguintes {x6.mean():+5.1f}% (abaixo em {100*(x6<0).mean():3.0f}% dos dias) | "
              f"vs 12 meses seguintes {x12.mean():+5.1f}% (abaixo em {100*(x12<0).mean():3.0f}%)  [{m.sum()} dias]")


def excepcional_inside(df_score, df, enter=-0.03, exit_=-0.01):
    eps = episodes(df, enter, exit_)
    inside = pd.Series(False, index=df.index)
    for a, b in eps:
        inside.loc[a:b] = True
    sc = df_score.score.reindex(df.index)
    p95 = df_score.score.quantile(0.95)
    years = (df.index[-1] - df.index[0]).days / 365.25
    hi = sc >= p95
    print(f"\n=== Dias excepcionais de curto prazo (score ≥ P95 = {p95:.0f}): {hi.sum()/years:.1f}/ano no total, "
          f"{(hi & inside).sum()/years:.1f}/ano dentro de boa época")


def current(df, label):
    last = df.iloc[-1]
    eps = episodes(df, -0.03, -0.01)
    start = eps[-1][0] if eps and eps[-1][1] is None else None
    print(f"\n=== Hoje ({label}, {df.index[-1].date()}): preço {last.p:.4f}, média de 12 meses {last.p/(1+last.dist):.4f}, "
          f"distância {100*last.dist:+.1f}%" + (f", boa época desde {start.date()}" if start is not None else ", fora de boa época"))


if __name__ == "__main__":
    ecb = base(load_ecb())
    wise = base(load_wise_daily())
    describe(ecb, "BCE")
    describe(wise, "Wise")
    quality(ecb, "BCE 2003-2025")
    quality(wise, "Wise 2022-2025")
    excepcional_inside(indicators(load_ecb()), ecb)
    current(ecb, "BCE")
    current(wise, "Wise")
