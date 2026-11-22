#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基准对照：策略选出的日子 vs 随便买的日子"""
import os, glob, csv

CSV_DIR = "/home/ubuntu/stock-picker/data/min5_pool"
FEE = 0.26
AMP_THR, AMP_DAYS, BODY_MAX = 3.0, 3, 1.0


def load_min5(path):
    days, order = {}, []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for row in csv.reader(f):
            if len(row) < 6: continue
            d = row[0].strip()
            try:
                o, h, l, c = float(row[2]), float(row[3]), float(row[4]), float(row[5])
            except (ValueError, IndexError): continue
            if d not in days:
                days[d] = (d, []); order.append(d)
            days[d][1].append((o, h, l, c))
    return [days[k] for k in order]


def agg(days):
    return [(d, b[0][0], max(x[1] for x in b), min(x[2] for x in b), b[-1][3]) for d, b in days]


def ma(v, n, i):
    return None if i + 1 < n else sum(v[i + 1 - n:i + 1]) / n


def sim(bars, buy, tp, sl):
    tgt, stp = buy * (1 + tp / 100), buy * (1 - sl / 100)
    for bo, bh, bl, bc in bars:
        if bo <= stp: return (bo / buy - 1) * 100
        if bo >= tgt: return (bo / buy - 1) * 100
        if bl <= stp: return -sl
        if bh >= tgt: return tp
    return (bars[-1][3] / buy - 1) * 100


def stat(r):
    n = len(r); w = sum(1 for x in r if x > 0)
    return n, w / n * 100 if n else 0, sum(r) / n if n else 0, sum(r)


def main():
    strat, base_next, base_close = [], [], []
    for fp in sorted(glob.glob(os.path.join(CSV_DIR, "*.csv"))):
        code = os.path.basename(fp).replace(".csv", "")
        days = load_min5(fp)
        if len(days) < 120: continue
        dy = agg(days); cl = [x[4] for x in dy]
        for i in range(25, len(dy) - 1):
            # 基准1：次日开盘买，全部交易日
            base_next.append(sim(days[i + 1][1][1:], days[i + 1][1][0][3], 3, 2) - FEE)
            # 基准2：收盘买，全部交易日
            base_close.append(sim(days[i + 1][1], cl[i], 3, 2) - FEE)
            # 策略
            ok = True
            for k in range(i - AMP_DAYS + 1, i + 1):
                pc = cl[k - 1]
                if pc <= 0: ok = False; break
                if (dy[k][2] - dy[k][3]) / pc * 100 <= AMP_THR: ok = False; break
                m5, m20 = ma(cl, 5, k), ma(cl, 20, k)
                if m5 is None or m20 is None or dy[k][4] <= m5 or dy[k][4] <= m20:
                    ok = False; break
            if not ok: continue
            if abs(dy[i][4] - dy[i][1]) / cl[i - 1] * 100 > BODY_MAX: continue
            strat.append(sim(days[i + 1][1][1:], days[i + 1][1][0][3], 3, 2) - FEE)
    print("统一用 tp3/sl2 + 次日开盘买\n")
    print("  策略选中日   n=%d 胜率%.1f%% 均值%+.3f%% 合计%+.0f%%" % stat(strat))
    print("  全部交易日   n=%d 胜率%.1f%% 均值%+.3f%% 合计%+.0f%%" % stat(base_next))


if __name__ == "__main__":
    main()
