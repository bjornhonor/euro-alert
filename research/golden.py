"""Gera test/fixtures/golden.json: entradas reais e os valores esperados dos indicadores,
calculados com o código da pesquisa (pandas). Os testes em TypeScript (test/unit/golden.test.ts)
têm de reproduzir esses números com tolerância de 1e-9.

    python research/golden.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from analise_preliminar import D, indicators, load_ecb
from analise_v8 import base
from analise_v9 import add_trend

OUT = Path(__file__).parent.parent / "test" / "fixtures" / "golden.json"


def ipca_obs():
    rows = json.load(open(D / "ipca_433.json"))
    return [{"date": pd.to_datetime(r["data"], dayfirst=True).strftime("%Y-%m-01"), "value": float(r["valor"])} for r in rows]


def hicp_obs():
    h = json.load(open(D / "hicp_minr.json"))
    t = h["dimension"]["time"]["category"]["index"]
    return sorted(({"date": f"{k}-01", "value": h["value"][str(v)]} for k, v in t.items() if str(v) in h["value"]),
                  key=lambda o: o["date"])


def index_map(obs, cumulative):
    s = pd.Series({pd.Period(o["date"][:7], "M"): o["value"] for o in obs}).sort_index()
    return 100 * (1 + s / 100).cumprod() if cumulative else s


def extend(s, until):
    """Meses que faltam: variação mensal média (geométrica) dos últimos 12 meses conhecidos."""
    s = s.copy()
    monthly = (s.iloc[-1] / s.iloc[-13]) ** (1 / 12)
    while s.index[-1] < until:
        s.loc[s.index[-1] + 1] = s.iloc[-1] * monthly
    return s


def k_series(ipca, hicp, until):
    return extend(index_map(ipca, True), until) / extend(index_map(hicp, False), until)


def real_context(s, k):
    """Contexto do último dia de `s`: média real, distância e fração de dias mais caros."""
    months = s.index.to_period("M")
    d = s.values / k.reindex(months).values
    k_today = k.loc[months[-1]]
    today = s.iloc[-1] / k_today
    m = k_today * d.mean()
    return {"mean": m, "dist": s.iloc[-1] / m - 1, "cheaperThan": float((d > today).mean()), "days": len(d)}


def seasonality(s):
    m = s.groupby(s.index.to_period("M")).mean()
    trend = m.rolling(12, center=True).mean().rolling(2).mean().shift(-1)
    ratio = (m / trend - 1).dropna() * 100
    g = ratio.groupby(ratio.index.month)
    return {int(k): {"mean": float(v.mean()), "n": int(v.count())} for k, v in g}


def main():
    s = load_ecb()
    ind = indicators(s).reindex(s.index)
    epo = add_trend(base(s)).reindex(s.index)
    p = s.values
    ipca, hicp = ipca_obs(), hicp_obs()
    k = k_series(ipca, hicp, s.index[-1].to_period("M"))

    picks = sorted({len(s) - 1, len(s) - 2, len(s) - 38, int(s.index.searchsorted("2015-06-15")),
                    int(s.index.searchsorted("2008-10-24")), 1300})
    points = []
    for i in picks:
        y1, y5 = p[max(0, i - 249): i + 1], p[max(0, i - 1259): i + 1]
        sma1260 = pd.Series(p[: i + 1]).rolling(1260).mean().iloc[-1]
        points.append({
            "i": i, "date": s.index[i].strftime("%Y-%m-%d"), "price": p[i],
            "z20": ind.z20.iloc[i], "pct90": ind.pct90.iloc[i], "rsi": ind.rsi.iloc[i],
            "sd60": ind.sd60.iloc[i], "ret5": ind.ret5.iloc[i], "score": ind.score.iloc[i],
            "dist250": epo.dist.iloc[i], "slope250": epo.slope250.iloc[i],
            "aboveSma20": bool(epo.acima_sma20.iloc[i]), "aboveSma50": bool(epo.acima_sma50.iloc[i]),
            "pct250": float((y1 > p[i]).mean()) if i >= 249 else None,
            "dist1260": p[i] / sma1260 - 1 if i >= 1259 else None,
            "pct1260": float((y5 > p[i]).mean()) if i >= 1259 else None,
            "real": real_context(s.iloc[: i + 1], k),
        })

    out = {
        "source": "BCE via Frankfurter (research/data/ecb_eurbrl.json), IPCA SGS 433, HICP Eurostat prc_hicp_minr I25",
        "dates": [d.strftime("%Y-%m-%d") for d in s.index],
        "prices": [float(x) for x in p],
        "ipca": ipca,
        "hicp": hicp,
        "points": points,
        "seasonality": seasonality(s),
    }
    OUT.write_text(json.dumps(out, default=lambda x: None if x is None or (isinstance(x, float) and np.isnan(x)) else float(x)))
    print(f"{OUT}: {len(s)} preços, {len(points)} pontos conferidos")


if __name__ == "__main__":
    main()
