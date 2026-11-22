#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中小盘池 · 盈亏比超短策略回测
全部指标与买卖价均来自同一套 5 分钟数据（自聚合日线），避免跨源复权错位。
条件：最近 3 个交易日各自振幅>3%，且这 3 天收盘都在 MA5、MA20 上方；今日实体小；收盘买入。
卖出：次日 5 分钟逐根，+3% 止盈 / -1% 止损，跳空按开盘，同根双触按先亏，都没触则收盘平。
"""
import os, sys, glob, csv, statistics as st

CSV_DIR = "/home/ubuntu/stock-picker/data/min5_pool"
FEE = 0.26
TP, SL = 3.0, 1.0
BODY_MAX = 1.0
AMP_THR = 3.0
AMP_DAYS = 3


def load_min5(path):
    """返回 [(date, bars)]，bars=[(o,h,l,c), ...]"""
    days = {}
    order = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        rd = csv.reader(f)
        for row in rd:
            if len(row) < 6:
                continue
            date = row[0].strip()
            try:
                o, h, l, c = float(row[2]), float(row[3]), float(row[4]), float(row[5])
            except (ValueError, IndexError):
                continue
            if date not in days:
                days[date] = (date, [])
                order.append(date)
            days[date][1].append((o, h, l, c))
    return [days[k] for k in order]


def agg_daily(days):
    """聚合成日线：[(date, o,h,l,c)]"""
    out = []
    for date, bars in days:
        o = bars[0][0]
        c = bars[-1][3]
        h = max(b[1] for b in bars)
        l = min(b[2] for b in bars)
        out.append((date, o, h, l, c))
    return out


def ma(vals, n, i):
    if i + 1 < n:
        return None
    seg = vals[i + 1 - n:i + 1]
    return sum(seg) / n


def main():
    files = sorted(glob.glob(os.path.join(CSV_DIR, "*.csv")))
    if not files:
        print("没有数据"); return
    all_trades = []
    per_stock = {}

    for fp in files:
        code = os.path.basename(fp).replace(".csv", "")
        days = load_min5(fp)
        if len(days) < 120:
            continue
        daily = agg_daily(days)
        closes = [d[4] for d in daily]
        # 日线索引 -> 5分钟
        daymap = {days[i][0]: i for i in range(len(days))}

        n_tr = 0
        for i in range(len(daily) - 1):
            date, o, h, l, c = daily[i]
            if i < 25:
                continue
            ma5 = ma(closes, 5, i); ma20 = ma(closes, 20, i)
            if ma5 is None or ma20 is None:
                continue
            # 最近 AMP_DAYS 天（含今天）
            ok = True
            for k in range(i - AMP_DAYS + 1, i + 1):
                dk = daily[k]
                pc = closes[k - 1] if k >= 1 else dk[4]
                if pc <= 0: ok = False; break
                amp = (dk[2] - dk[3]) / pc * 100
                mak5 = ma(closes, 5, k); mak20 = ma(closes, 20, k)
                if amp <= AMP_THR: ok = False; break
                if mak5 is None or mak20 is None: ok = False; break
                if dk[4] <= mak5 or dk[4] <= mak20: ok = False; break
            if not ok:
                continue
            # 今日实体小
            pc = closes[i - 1]
            body = abs(c - o) / pc * 100
            if body > BODY_MAX:
                continue

            # 次日 5 分钟模拟
            ndate = days[i + 1][0]
            bars = days[i + 1][1]
            buy = c
            tgt = buy * (1 + TP / 100)
            stp = buy * (1 - SL / 100)
            res = None
            for (bo, bh, bl, bc) in bars:
                if bo <= stp:
                    res = (bo / buy - 1) * 100 + 0; res = ("S", res); break
                if bo >= tgt:
                    res = ("T", (bo / buy - 1) * 100); break
                if bl <= stp:
                    res = ("S", -SL); break
                if bh >= tgt:
                    res = ("T", TP); break
            if res is None:
                last = bars[-1][3]
                res = ("C", (last / buy - 1) * 100)
            kind, pct = res
            net = pct - FEE
            all_trades.append((code, date, kind, pct, net))
            n_tr += 1

        per_stock[code] = n_tr

    if not all_trades:
        print("无候选"); return

    n = len(all_trades)
    wins = sum(1 for t in all_trades if t[4] > 0)
    avg = sum(t[4] for t in all_trades) / n
    tot = sum(t[4] for t in all_trades)
    kinds = {}
    for t in all_trades:
        kinds[t[2]] = kinds.get(t[2], 0) + 1
    print(f"总候选 {n}  胜率 {wins/n*100:.1f}%  平均每笔 {avg:+.3f}%  合计 {tot:+.1f}%")
    print("出场分布:", {k: f"{v}({v/n*100:.1f}%)" for k, v in sorted(kinds.items())})
    print("\n分股:")
    for code, cnt in sorted(per_stock.items()):
        ts = [t for t in all_trades if t[0] == code]
        if not ts:
            print(f"  {code} 0"); continue
        a = sum(t[4] for t in ts) / len(ts)
        w = sum(1 for t in ts if t[4] > 0)
        print(f"  {code} n={len(ts):3d} 胜率{w/len(ts)*100:5.1f}% 均值{a:+.3f}%")


if __name__ == "__main__":
    main()
