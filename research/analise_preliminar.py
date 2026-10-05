"""Análise preliminar EUR/BRL: propriedades estatísticas + simulação da estratégia
"fatias por nível do dia + intervalo mínimo" contra DCA, com a tarifa real da Wise.

Dados: BCE via Frankfurter (2002-2026, dias úteis) e Wise diário (5 anos).
Tarifa Wise BRL->EUR ajustada da API de comparação: fee = 2.18 + 3.975% do valor.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

D = Path(__file__).parent / "data"
FIX, VAR = 2.18, 0.03975
RNG = np.random.default_rng(42)


def load_ecb():
    d = json.load(open(D / "ecb_eurbrl.json"))
    s = pd.Series({pd.Timestamp(k): v["BRL"] for k, v in d["rates"].items()}).sort_index()
    return s[s.index >= "2002-01-01"]


def load_wise_daily():
    d = json.load(open(D / "wise_daily5y.json"))
    s = pd.Series({pd.Timestamp(x["time"], unit="ms").normalize(): x["value"] for x in d}).sort_index()
    s = s[~s.index.duplicated(keep="last")]
    return s[s.index.dayofweek < 5]


# ---------------------------------------------------------------- estatística
def stats(s, label):
    lp = np.log(s)
    r = lp.diff().dropna()
    out = {"serie": label, "dias": len(r), "vol_anual_%": r.std() * np.sqrt(252) * 100}
    for k in (1, 2, 5):
        out[f"autocorr_lag{k}"] = r.autocorr(k)
    v1 = r.var()
    for q in (5, 20, 60):
        out[f"VR{q}"] = lp.diff(q).dropna().var() / (q * v1)
    return out


def indicators(s):
    df = pd.DataFrame({"p": s})
    lp = np.log(s)
    r = lp.diff()
    df["z20"] = (s - s.rolling(20).mean()) / s.rolling(20).std()
    df["pct90"] = s.rolling(90).rank(pct=True)
    delta = s.diff()
    ag = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    al = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    df["rsi"] = 100 - 100 / (1 + ag / al)
    df["sd60"] = r.rolling(60).std()
    df["ret5"] = lp.diff(5)
    c1 = 1 - df.pct90
    c2 = (-df.z20 / 2.5).clip(0, 1)
    c3 = ((50 - df.rsi) / 20).clip(0, 1)
    c4 = (-df.ret5 / (1.5 * df.sd60 * np.sqrt(5))).clip(0, 1)
    df["score"] = 100 * (0.35 * c1 + 0.25 * c2 + 0.15 * c3 + 0.15 * c4) / 0.90
    return df.dropna()


def forward_table(df):
    lp = np.log(df.p)
    bins = [0, 20, 40, 55, 70, 85, 101]
    labels = ["0-20", "20-40", "40-55", "55-70", "70-85", "85-100"]
    cat = pd.cut(df.score, bins=bins, labels=labels, right=False)
    rows = []
    for h in (5, 10, 20):
        fr = (lp.shift(-h) - lp) * 100
        g = fr.groupby(cat, observed=False)
        base = fr.mean()
        for lab in labels:
            x = g.get_group(lab).dropna() if lab in g.groups else pd.Series(dtype=float)
            se = x.std() / np.sqrt(max(len(x) / h, 1)) if len(x) > 1 else np.nan
            rows.append({"h_dias": h, "score": lab, "n": len(x), "ret_fut_medio_%": x.mean(),
                         "vs_incondicional_pp": x.mean() - base, "erro_padrao_aprox": se})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- estratégias
def months(df):
    return [g for _, g in df.groupby(df.index.to_period("M"))]


def dca_daily(df, budget):
    buys = []
    for g in months(df):
        a = budget / len(g)
        buys += [(d, a, p) for d, p in g.p.items()]
    return buys


def dca_weekly(df, budget):
    buys = []
    for g in months(df):
        wk = g.groupby(g.index.isocalendar().week.values).head(1)
        a = budget / len(wk)
        buys += [(d, a, p) for d, p in wk.p.items()]
    return buys


def dca_monthly(df, budget):
    return [(g.index[0], budget, g.p.iloc[0]) for g in months(df)]


def tiered(df, budget, th, slices, cooldown, carry=False, cap_months=2):
    buys, forced = [], []
    carry_amt, last_pos = 0.0, -10**9
    pos = {d: i for i, d in enumerate(df.index)}
    for g in months(df):
        avail = budget + carry_amt
        idx = list(g.index)
        for j, d in enumerate(idx):
            i, s, p = pos[d], g.at[d, "score"], g.at[d, "p"]
            if i - last_pos >= cooldown and avail > 1e-9:
                tier = 3 if s >= th[2] else 2 if s >= th[1] else 1 if s >= th[0] else 0
                if tier:
                    a = min(slices[tier - 1], avail)
                    buys.append((d, a, p)); avail -= a; last_pos = i
            if j == len(idx) - 1:
                if not carry and avail > 1e-9:
                    buys.append((d, avail, p)); forced.append(avail); avail = 0.0; last_pos = i
                elif carry and avail - cap_months * budget > 1e-9:
                    ex = avail - cap_months * budget
                    buys.append((d, ex, p)); forced.append(ex); avail -= ex; last_pos = i
        carry_amt = avail if carry else 0.0
    if carry and carry_amt > 1e-9:
        buys.append((df.index[-1], carry_amt, df.p.iloc[-1])); forced.append(carry_amt)
    return buys, forced


def evaluate(buys):
    brl = np.array([b[1] for b in buys]); p = np.array([b[2] for b in buys])
    fee = FIX + VAR * brl
    return {"compras": len(buys), "brl": brl.sum(),
            "preco_efetivo": brl.sum() / ((brl - fee) / p).sum(),  # com tarifa
            "preco_mid": brl.sum() / (brl / p).sum(),              # só timing
            "tarifa_%": 100 * fee.sum() / brl.sum()}


def adv(base, strat, key):
    return 100 * (base[key] - strat[key]) / base[key]


def placebo(df, buys, n=400):
    """Mesmos valores por mês, em dias úteis aleatórios do mesmo mês."""
    by_month = {}
    for d, a, _ in buys:
        by_month.setdefault(d.to_period("M"), []).append(a)
    groups = {per: g for per, g in df.groupby(df.index.to_period("M"))}
    mids = []
    for _ in range(n):
        num = den = 0.0
        for per, amts in by_month.items():
            g = groups[per]
            k = min(len(amts), len(g))
            ii = RNG.choice(len(g), size=k, replace=False)
            px = g.p.values[ii]
            a = np.array(amts[:k])
            num += a.sum(); den += (a / px).sum()
        mids.append(num / den)
    return np.array(mids)


def per_year(df, base_buys, strat_buys, key="preco_efetivo"):
    rows = []
    for y in sorted({d.year for d, _, _ in base_buys}):
        b = evaluate([x for x in base_buys if x[0].year == y])
        s = evaluate([x for x in strat_buys if x[0].year == y])
        rows.append(adv(b, s, key))
    return np.array(rows)


def run_block(df, label, budget=1200.0, slices=(150, 225, 300), cooldowns=(1, 3, 5), do_placebo=True):
    q = df.score.quantile([0.70, 0.85, 0.95]).values
    print(f"\n=== {label}: {df.index[0].date()} a {df.index[-1].date()} | orçamento R${budget:.0f}/mês")
    print(f"limiares do score (top 30/15/5% dos dias): {np.round(q, 1)}")
    bench = {"DCA diário": evaluate(dca_daily(df, budget)),
             "DCA semanal": evaluate(dca_weekly(df, budget)),
             "DCA mensal": evaluate(dca_monthly(df, budget))}
    for k, v in bench.items():
        print(f"{k:28s} compras/mês={v['compras']/len(months(df)):5.1f}  efetivo={v['preco_efetivo']:.4f}  "
              f"mid={v['preco_mid']:.4f}  tarifa={v['tarifa_%']:.2f}%")
    wk = bench["DCA semanal"]; mo = bench["DCA mensal"]
    results = {}
    for carry in (False, True):
        for cd in cooldowns:
            buys, forced = tiered(df, budget, q, slices, cd, carry=carry)
            ev = evaluate(buys)
            name = f"fatias cd={cd} {'acumula' if carry else 'força fim mês'}"
            results[name] = (ev, buys)
            print(f"{name:28s} compras/mês={ev['compras']/len(months(df)):5.1f}  efetivo={ev['preco_efetivo']:.4f}  "
                  f"mid={ev['preco_mid']:.4f}  tarifa={ev['tarifa_%']:.2f}%  forçado={100*sum(forced)/ev['brl']:.0f}%  "
                  f"| vs semanal: timing {adv(wk, ev, 'preco_mid'):+.2f}% total {adv(wk, ev, 'preco_efetivo'):+.2f}%  "
                  f"| vs mensal: timing {adv(mo, ev, 'preco_mid'):+.2f}% total {adv(mo, ev, 'preco_efetivo'):+.2f}%")
    if do_placebo:
        name = "fatias cd=3 força fim mês"
        ev, buys = results[name]
        pl = placebo(df, buys)
        pval = (pl <= ev["preco_mid"]).mean()
        print(f"placebo ({name}): mid estratégia={ev['preco_mid']:.4f}  placebo médio={pl.mean():.4f}  "
              f"vantagem vs placebo={100*(pl.mean()-ev['preco_mid'])/pl.mean():+.2f}%  p≈{pval:.3f}")
        yrs = per_year(df, dca_weekly(df, budget), buys)
        print(f"por ano vs DCA semanal (efetivo): média {yrs.mean():+.2f}%  mediana {np.median(yrs):+.2f}%  "
              f"anos positivos {100*(yrs>0).mean():.0f}%  pior {yrs.min():+.2f}%  melhor {yrs.max():+.2f}%")
    return results


def synthetic_check(df_real, n_paths=60, budget=1200.0):
    """Passeio aleatório com a mesma vol: estratégia não deveria ganhar do placebo."""
    sd = np.log(df_real.p).diff().std()
    idx = df_real.index
    advs = []
    for _ in range(n_paths):
        path = df_real.p.iloc[0] * np.exp(np.cumsum(RNG.normal(0, sd, len(idx))))
        df = indicators(pd.Series(path, index=idx))
        q = df.score.quantile([0.70, 0.85, 0.95]).values
        buys, _ = tiered(df, budget, q, (150, 225, 300), 3)
        ev = evaluate(buys)
        pl = placebo(df, buys, n=60)
        advs.append(100 * (pl.mean() - ev["preco_mid"]) / pl.mean())
    advs = np.array(advs)
    print(f"\n=== sanidade (passeio aleatório, {n_paths} caminhos): vantagem de timing vs placebo "
          f"média {advs.mean():+.3f}%  desvio {advs.std():.3f}%")


if __name__ == "__main__":
    pd.set_option("display.width", 200)
    ecb = load_ecb()
    wise = load_wise_daily()
    print(pd.DataFrame([stats(ecb, "BCE 2002-2026"), stats(ecb[ecb.index >= "2016-01-01"], "BCE 2016-2026"),
                        stats(wise, "Wise 2021-2026")]).round(4).to_string(index=False))
    df = indicators(ecb)
    print("\nRetorno futuro do EUR/BRL por faixa de score (positivo = euro subiu depois = bom ter comprado):")
    ft = forward_table(df)
    print(ft.round(3).to_string(index=False))
    run_block(df, "BCE")
    run_block(indicators(wise), "Wise diário")
    run_block(df[df.index >= "2016-01-01"], "BCE últimos 10 anos", do_placebo=True)
    if "--sanity" in sys.argv:
        synthetic_check(df)
