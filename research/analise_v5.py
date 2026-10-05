"""V5: dinheiro parado na conta (sem CDI) + regra agressiva detalhada + filtros de regime,
e horário do dia (Yahoo 1h)."""
import numpy as np
import pandas as pd

from analise_preliminar import D, FIX, VAR, indicators, load_ecb, load_wise_daily, months


def eff_price(buys):
    brl = np.array([b[1] for b in buys]); p = np.array([b[2] for b in buys])
    return brl.sum() / ((brl - (FIX + VAR * brl)) / p).sum()


def buy_on_day(df, budget, k):
    return [(g.index[min(k, len(g) - 1)], budget, g.p.iloc[min(k, len(g) - 1)]) for g in months(df)]


def convex_in(g, budget, n_days, tau_max, power=3.0):
    n = min(n_days, len(g))
    for k in range(n):
        tau = tau_max * (1 - (k / (n - 1)) ** power) if n > 1 else 0
        if k == n - 1 or g.score.iloc[k] >= tau:
            return (g.index[k], budget, g.p.iloc[k])


def aggressive(df, budget, tau_max, n_days=99, flag=None):
    """Regra agressiva (limiar convexo) nos primeiros n_days úteis; se flag (coluna booleana)
    for dada, só usa a regra nos meses em que a flag está ligada no 1º dia; senão compra no dia 1."""
    out = []
    for g in months(df):
        if flag is not None and not bool(g[flag].iloc[0]):
            out.append((g.index[0], budget, g.p.iloc[0]))
        else:
            out.append(convex_in(g, budget, n_days, tau_max))
    return out


def per_year(base, strat):
    ys = sorted({d.year for d, _, _ in base})
    diffs = []
    for y in ys:
        b = [x for x in base if x[0].year == y]; s = [x for x in strat if x[0].year == y]
        diffs.append(100 * (eff_price(b) - eff_price(s)) / eff_price(b))
    return np.array(diffs)


def add_filters(df):
    lp = np.log(df.p)
    r1 = lp.diff()
    r20 = lp.diff(20)
    vr = (r20.rolling(250).var() / (20 * r1.rolling(250).var())).shift(1)
    df = df.copy()
    df["f_volta_media"] = vr < 0.8                     # regime de volta à média no último ano
    sma200 = df.p.rolling(200).mean()
    df["f_tendencia_queda"] = (df.p.shift(1) < sma200.shift(1))  # euro abaixo da média de 200 dias
    return df


def block_idle(df, label, budget=500.0):
    tau = df.score.quantile(0.95)
    base = buy_on_day(df, budget, 0)
    strat = {
        "Compra no dia 1 (chegada do dinheiro)": base,
        "Compra no último dia útil": [(g.index[-1], budget, g.p.iloc[-1]) for g in months(df)],
        "Agressiva, mês inteiro": aggressive(df, budget, tau),
        "Agressiva, primeiros 10 dias úteis": aggressive(df, budget, tau, 10),
        "Agressiva, primeiros 5 dias úteis": aggressive(df, budget, tau, 5),
        "Agressiva só em regime de volta à média": aggressive(df, budget, tau, flag="f_volta_media"),
        "Agressiva só com euro em tendência de queda": aggressive(df, budget, tau, flag="f_tendencia_queda"),
    }
    b = eff_price(base)
    on_vr = 100 * np.mean([bool(g.f_volta_media.iloc[0]) for g in months(df)])
    on_tr = 100 * np.mean([bool(g.f_tendencia_queda.iloc[0]) for g in months(df)])
    print(f"\n=== {label} | dinheiro parado (sem CDI) | R${budget:.0f}/mês | filtro volta à média ligado em {on_vr:.0f}% dos meses, "
          f"tendência de queda em {on_tr:.0f}%")
    print(f"{'estratégia':44s} {'vs dia 1':>9s} {'anos +':>7s} {'pior ano':>9s} {'melhor ano':>10s}")
    for n, s in strat.items():
        y = per_year(base, s)
        print(f"{n:44s} {100*(b-eff_price(s))/b:+8.2f}% {100*(y>0).mean():6.0f}% {y.min():+8.2f}% {y.max():+9.2f}%")


def thresholds_table(tau_max=83.0, n=21):
    print(f"\nLimiar por dia útil (mês de {n} dias, limiar inicial {tau_max:.0f}):")
    print("dia | linear | convexo (p=3)")
    for k in (0, 4, 9, 12, 14, 16, 18, 19, 20):
        lin = tau_max * (1 - k / (n - 1)); cvx = tau_max * (1 - (k / (n - 1)) ** 3)
        print(f"{k+1:3d} | {lin:6.1f} | {cvx:6.1f}")


def hour_of_day():
    h = pd.read_csv(D / "yahoo_eurbrl_1h.csv")
    t = pd.to_datetime(h.ts, unit="s") - pd.Timedelta(hours=3)   # horário de Brasília
    s = pd.Series(np.log(h.close.values), index=t)
    s = s[(s.index.dayofweek < 5) & (s.index.hour >= 9) & (s.index.hour <= 17)]
    df = pd.DataFrame({"lp": s, "day": s.index.date, "hour": s.index.hour})
    cnt = df.groupby("day").lp.transform("count")
    df = df[cnt >= 8]
    df["dev_bp"] = (df.lp - df.groupby("day").lp.transform("mean")) * 1e4
    g = df.groupby("hour").dev_bp
    res = pd.DataFrame({"media_bp": g.mean(), "erro_padrao_bp": g.std() / np.sqrt(g.count()), "dias": g.count()})
    print(f"\n=== Horário do dia (Yahoo 1h, {df.day.nunique()} dias úteis, {df.index.min().date()} a {df.index.max().date()})")
    print("desvio médio do preço em relação à média do dia (pontos-base; negativo = euro mais barato naquela hora)")
    print(res.round(2).to_string())


if __name__ == "__main__":
    thresholds_table()
    full = add_filters(indicators(load_ecb()))
    block_idle(full, "BCE 2002-2026")
    block_idle(full[(full.index >= "2016-01-01") & (full.index < "2022-01-01")], "BCE 2016-2021 (real em tendência de queda)")
    block_idle(full[full.index >= "2022-01-01"], "BCE 2022-2026 (câmbio de lado)")
    wise = indicators(load_wise_daily())
    flags = full[["f_volta_media", "f_tendencia_queda"]].reindex(wise.index, method="ffill").fillna(False)
    block_idle(wise.join(flags).loc["2022-01-01":], "Wise 2022-2026 (filtros calculados com a série do BCE)")
    hour_of_day()
