"""V7: robustez da regra "boa época" (limiar abaixo da média de 1 ano x prazo máximo de espera)
e variante que evita comprar em dezembro, o mês historicamente mais caro."""
import numpy as np

from analise_preliminar import load_ecb
from analise_v2 import load_cdi_index
from analise_v6 import add_signals, r_monthly, simulate

PERIODS = [("2005-01-01", "2026-09-23", "2005-26"),
           ("2016-01-01", "2021-12-31", "2016-21"),
           ("2022-01-01", "2026-09-23", "2022-26")]


def r_signal_dec(t, i, row, per, mw, is_first, gap, col, thr, mmax, skip_dec):
    if skip_dec and per.month == 12:
        return False                              # dezembro: não compra, nem no prazo máximo
    if is_first and mw >= mmax:
        return True
    return gap >= 20 and row[col] <= thr


def grid(df, C):
    thrs = (-0.02, -0.03, -0.04, -0.05)
    mmaxes = (4, 6, 9)
    for mode in ("parado", "cdi"):
        print(f"\n=== Grade: dinheiro {mode} | vantagem vs comprar todo mês (%), por período {', '.join(p[2] for p in PERIODS)}")
        print("limiar \\ prazo máx. | " + " | ".join(f"{m} meses".center(22) for m in mmaxes))
        for thr in thrs:
            cells = []
            for mm in mmaxes:
                vals = []
                for a, b, _ in PERIODS:
                    base = simulate(df, C, mode, r_monthly, a, b)["preco"]
                    r = simulate(df, C, mode, r_signal_dec, a, b, col="dist250", thr=thr, mmax=mm, skip_dec=False)
                    vals.append(100 * (base - r["preco"]) / base)
                cells.append(" ".join(f"{v:+5.2f}" for v in vals))
            print(f"{thr*100:+.0f}% abaixo da média | " + " | ".join(c.center(22) for c in cells))


def december(df, C):
    print("\n=== Evitar dezembro (limiar −3%, prazo máximo 6 meses)")
    for mode in ("parado", "cdi"):
        for a, b, lab in PERIODS:
            base = simulate(df, C, mode, r_monthly, a, b)["preco"]
            r0 = simulate(df, C, mode, r_signal_dec, a, b, col="dist250", thr=-0.03, mmax=6, skip_dec=False)
            r1 = simulate(df, C, mode, r_signal_dec, a, b, col="dist250", thr=-0.03, mmax=6, skip_dec=True)
            print(f"{mode:6s} {lab}: sem ajuste {100*(base-r0['preco'])/base:+.2f}% | evitando dezembro {100*(base-r1['preco'])/base:+.2f}%")


if __name__ == "__main__":
    df = add_signals(load_ecb())
    C = load_cdi_index()
    grid(df, C)
    december(df, C)
