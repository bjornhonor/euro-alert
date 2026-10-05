"""V10: contexto do alerta além dos 12 meses — média de 5 anos e câmbio real (corrigido pela
inflação do Brasil e da zona do euro) contra a história desde 2002. Também mede quantas épocas
chegam aos níveis −5% e −8% (alertas por ano) e se o contexto de 5 anos ou o câmbio real
melhora a qualidade do sinal."""
import json

import numpy as np
import pandas as pd

from analise_preliminar import D, load_ecb
from analise_v8 import episodes

HICP_2026_MENSAL = 0.02 / 12   # a Eurostat ainda não publicou 2026 nessa série: completa com 2% a.a.


def load_ipca_index():
    rows = json.load(open(D / "ipca_433.json"))
    s = pd.Series({pd.to_datetime(r["data"], dayfirst=True).to_period("M"): float(r["valor"]) for r in rows}).sort_index()
    return 100 * (1 + s / 100).cumprod()


def load_hicp_index(last_month):
    h = json.load(open(D / "hicp_ea.json"))
    t = h["dimension"]["time"]["category"]["index"]
    s = pd.Series({pd.Period(k, "M"): h["value"][str(v)] for k, v in t.items() if str(v) in h["value"]}).sort_index()
    p = s.index[-1]
    while p < last_month:
        p += 1
        s.loc[p] = s.iloc[-1] * (1 + HICP_2026_MENSAL)
    return s


def real_rate(s):
    """Câmbio real em reais de hoje: preço de cada dia corrigido pela inflação acumulada até agora."""
    ipca = load_ipca_index()
    months = s.index.to_period("M")
    last = months[-1]
    while ipca.index[-1] < last:          # mês corrente ainda sem IPCA: repete o último
        ipca.loc[ipca.index[-1] + 1] = ipca.iloc[-1]
    hicp = load_hicp_index(last)
    fator = (ipca.loc[last] / ipca.reindex(months).values) / (hicp.loc[last] / hicp.reindex(months).values)
    return pd.Series(s.values * fator, index=s.index)


def build(s):
    df = pd.DataFrame({"p": s})
    df["d12"] = s / s.rolling(250).mean() - 1
    df["d60"] = s / s.rolling(1260).mean() - 1                 # 5 anos
    df["real"] = real_rate(s)
    df["real_vs_hist"] = df.real / df.real.expanding(500).mean() - 1   # só com o passado
    fwd6 = s[::-1].rolling(126).mean()[::-1].shift(-1)
    fwd12 = s[::-1].rolling(250).mean()[::-1].shift(-1)
    df["q6"] = s / fwd6 - 1
    df["q12"] = s / fwd12 - 1
    return df


def levels(df):
    eps = episodes(df.rename(columns={"d12": "dist"}), -0.03, -0.01)
    years = (df.index[-1] - df.dropna(subset=["d12"]).index[0]).days / 365.25
    depths = []
    for a, b in eps:
        seg = df.loc[a:b] if b is not None else df.loc[a:]
        depths.append(seg.d12.min())
    depths = np.array(depths)
    r5, r8 = (depths <= -0.05).mean(), (depths <= -0.08).mean()
    per_year = len(eps) / years
    print(f"\n=== Níveis: {len(eps)} épocas ({per_year:.1f}/ano); chegaram a −5%: {100*r5:.0f}%; a −8%: {100*r8:.0f}%")
    print(f"alertas de época por ano ≈ {per_year*(2 + r5 + r8):.1f} (início + fim + níveis)")


def quality(df):
    d = df.dropna(subset=["q12", "d60", "real_vs_hist", "d12"])
    periods = [("2007", "2025", "total"), ("2007", "2014", "2007-14"), ("2015", "2020", "2015-20"), ("2021", "2025", "2021-25")]
    print("\n=== Boa época (12m ≤ −3%) com contexto de 5 anos e história: preço vs média dos 6 meses seguintes,"
          " descontando um dia qualquer do mesmo período (negativo = melhor)")
    header = " | ".join(f"{lab:>16s}" for _, _, lab in periods)
    print(f"{'filtro':44s} | {header}")
    filters = [
        ("12m ≤ −3%", lambda x: x.d12 <= -0.03),
        ("12m ≤ −3% e abaixo da média de 5 anos", lambda x: (x.d12 <= -0.03) & (x.d60 < 0)),
        ("12m ≤ −3% e acima da média de 5 anos", lambda x: (x.d12 <= -0.03) & (x.d60 >= 0)),
        ("12m ≤ −3% e câmbio real abaixo da história", lambda x: (x.d12 <= -0.03) & (x.real_vs_hist < 0)),
        ("12m ≤ −3% e câmbio real acima da história", lambda x: (x.d12 <= -0.03) & (x.real_vs_hist >= 0)),
    ]
    for name, f in filters:
        cells = []
        for a, b, _ in periods:
            x = d.loc[a:b]
            m = f(x)
            if m.sum() < 20:
                cells.append(f"{'—':>16s}")
                continue
            rel = (x.q6[m].mean() - x.q6.mean()) * 100
            cells.append(f"{rel:+6.1f}% ({m.sum():4d} d)")
        print(f"{name:44s} | " + " | ".join(cells))


def now(df, wise_last):
    last = df.iloc[-1]
    s = df.p
    y1, y5 = s.iloc[-250:], s.iloc[-1260:]
    hist_real_mean = df.real.mean()
    print(f"\n=== Hoje ({df.index[-1].date()}, BCE {last.p:.4f}; Wise {wise_last:.4f})")
    print(f"12 meses: média {y1.mean():.4f} ({100*last.d12:+.1f}%), mais barato que {100*(y1 > last.p).mean():.0f}% dos dias, "
          f"mín {y1.min():.4f} máx {y1.max():.4f}")
    print(f"5 anos:   média {y5.mean():.4f} ({100*(last.p/y5.mean()-1):+.1f}%), mais barato que {100*(y5 > last.p).mean():.0f}% dos dias, "
          f"mín {y5.min():.4f} máx {y5.max():.4f}")
    print(f"História (desde 2002, em reais de hoje): média {hist_real_mean:.4f} ({100*(last.p/hist_real_mean-1):+.1f}%), "
          f"mais barato que {100*(df.real > last.p).mean():.0f}% dos dias; "
          f"mín {df.real.min():.4f} em {df.real.idxmin().date()}, máx {df.real.max():.4f} em {df.real.idxmax().date()}")
    print(f"Nominal (sem corrigir): mais barato que {100*(s > last.p).mean():.0f}% dos dias desde 2002 — distorcido pela inflação")


if __name__ == "__main__":
    from analise_preliminar import load_wise_daily
    s = load_ecb()
    df = build(s)
    levels(df)
    quality(df)
    now(df, load_wise_daily().iloc[-1])
