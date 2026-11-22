#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3: 大盘环境过滤 + 个股趋势条件 + 三种卖出规则对照 + 按天统计"""
import sqlite3, json, os
from collections import defaultdict
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
DB = "/home/ubuntu/kline-trainer/kline-server/data/kline.db"
START = "2022-01-01"
DISCS = (0.010, 0.020)
MODES = ("mid", "t1", "t2")          # 等回中间价 / 次日+1% / 次日+2%
CONDS = ("base", "idx", "idx20", "idx20m5")

conn = sqlite3.connect(DB)
conn.execute("PRAGMA cache_size=-400000")

univ = {}
for c, n in conn.execute("select code,name from stocks"):
    if not c or not n:
        continue
    if "ST" in n.upper() or "退" in n:
        continue
    if c[2:5] in ("999", "888"):
        continue
    univ[c] = n


def limit_pct(code):
    b = code[:2]
    if b == "bj":
        return 0.30
    if code[2:4] == "30" or code[2:5] == "688":
        return 0.20
    return 0.10


idx = {}
for row in json.load(open(os.path.join(HERE, "idx_sh.json")))["data"]["sh000001"]["day"]:
    idx[row[0]] = (float(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[5]))
idx_dates = sorted(idx.keys())
idx_close = [idx[d][1] for d in idx_dates]
idx_vol = [idx[d][4] for d in idx_dates]
idx_pos = {d: i for i, d in enumerate(idx_dates)}


def idx_ctx(d):
    i = idx_pos.get(d)
    if i is None or i < 25:
        return None
    c0 = idx_close[i]
    ma5 = sum(idx_close[i - 4:i + 1]) / 5
    ma20 = sum(idx_close[i - 19:i + 1]) / 20
    downrun = 0
    j = i
    while j > 0 and idx_close[j] < idx_close[j - 1] and downrun < 12:
        downrun += 1
        j -= 1
    v20 = sum(idx_vol[i - 19:i + 1]) / 20
    return dict(d1=c0 / idx_close[i - 1] - 1, d5=c0 / idx_close[i - 5] - 1,
                d20=c0 / idx_close[i - 20] - 1, dev20=c0 / ma20 - 1,
                downrun=downrun, vr=(idx_vol[i] / v20 - 1) if v20 else 0)


def dbucket(r):
    return str(r) if r < 8 else "8+"


def abucket(a):
    if a < 5e7:
        return "<0.5亿"
    if a < 1.5e8:
        return "0.5-1.5亿"
    if a < 5e8:
        return "1.5-5亿"
    return ">5亿"


# key: (disc, cond, mode)
stat = defaultdict(lambda: dict(n=0, win=0, sret=0.0, swin=0.0, slose=0.0, tgt=0, worst=0.0))
byday = defaultdict(lambda: defaultdict(lambda: dict(n=0, win=0, sret=0.0)))
# 细分维度（固定 disc=1%, mode=mid, cond=base） 用于看大盘连跌曲线/流动性
fine = defaultdict(lambda: dict(n=0, win=0, sret=0.0, tgt=0))
idxday = {}
prev_day = [None]
cnt = [0]


def process(code, rows):
    n = len(rows)
    if n < 80:
        return
    lim = limit_pct(code)
    closes = [r[3] for r in rows]
    for i in range(21, n - 1):
        d, o, h, c, l, vol, amt, craw, gap = rows[i]
        if d < START:
            continue
        if not o or not h or not l or not c or l <= 0 or not vol:
            continue
        p = rows[i - 1]
        dh, dl, dc_ = p[2], p[4], p[3]
        if not dh or not dl or not dc_:
            continue
        mid = (dh + dl) / 2.0
        if gap > 15:
            continue
        if amt < 3e7:
            continue
        chg = c / dc_ - 1
        if chg <= -(lim - 0.004) and c <= l * 1.002:
            continue
        ctx = idx_ctx(d)
        if ctx is None:
            continue
        no, nh, nc = rows[i + 1][1], rows[i + 1][2], rows[i + 1][3]
        if not no or not nh or not nc:
            continue

        # 个股趋势状态
        ma5 = sum(closes[i - 4:i + 1]) / 5
        ma5p = sum(closes[i - 7:i - 2]) / 5 if i >= 7 else None
        ma20 = sum(closes[i - 19:i + 1]) / 20
        above20 = c > ma20
        m5up = (ma5 > ma5p) if ma5p else False
        # 近20日平均振幅
        amps = [abs(rows[k][2] - rows[k][4]) / rows[k - 1][3] for k in range(i - 19, i + 1) if rows[k - 1][3]]
        amp20 = sum(amps) / len(amps) if amps else 0

        ok = {"base": True,
              "idx": ctx["downrun"] >= 3,
              "idx20": ctx["downrun"] >= 3 and above20,
              "idx20m5": ctx["downrun"] >= 3 and above20 and m5up}

        for dcv in DISCS:
            if c > mid * (1 - dcv):
                continue
            depth = mid / c - 1
            for cond in CONDS:
                if not ok[cond]:
                    continue
                for mode in MODES:
                    if mode == "mid":
                        tgt = mid
                        if no >= tgt:
                            sell = no
                        elif nh >= tgt:
                            sell = tgt
                        else:
                            sell = nc
                    else:
                        tgt = c * (1 + (0.01 if mode == "t1" else 0.02))
                        if no >= tgt:
                            sell = no
                        elif nh >= tgt:
                            sell = tgt
                        else:
                            sell = nc
                    ret = sell / c - 1
                    if abs(ret) > 0.45:
                        continue
                    s = stat[(dcv, cond, mode)]
                    s["n"] += 1
                    s["sret"] += ret
                    if sell > c:
                        s["win"] += 1
                        s["swin"] += ret
                    else:
                        s["slose"] += ret
                    if ret < s["worst"]:
                        s["worst"] = ret
                    if mode == "mid" and (no >= mid or nh >= mid):
                        s["tgt"] += 1
                    if mode != "mid" and (no >= tgt or nh >= tgt):
                        s["tgt"] += 1
                    b = byday[(dcv, cond, mode)][d]
                    b["n"] += 1
                    b["sret"] += ret
                    if sell > c:
                        b["win"] += 1

            if dcv == 0.010:
                k = dbucket(ctx["downrun"])
                f = fine[("downrun", k)]
                f["n"] += 1
                f["sret"] += (no if no >= mid else (mid if nh >= mid else nc)) / c - 1
                if (no >= mid or nh >= mid):
                    f["tgt"] += 1
                if (no if no >= mid else (mid if nh >= mid else nc)) > c:
                    f["win"] += 1
                for kk, vv in (("liq", abucket(amt)), ("amp", "深" if depth / amp20 >= 0.6 else "浅")):
                    f = fine[(kk, vv)]
                    r_ = (no if no >= mid else (mid if nh >= mid else nc)) / c - 1
                    f["n"] += 1
                    f["sret"] += r_
                    if r_ > 0:
                        f["win"] += 1
                r_ = (no if no >= mid else (mid if nh >= mid else nc)) / c - 1
                f = fine[("disc", "1%")] if dcv == 0.010 else None
        idxday[d] = ctx


def flush(code, buf):
    out = []
    pd = None
    for x in buf:
        dd = str(x[0])
        g = 0
        if pd is not None:
            y0, m0, d0 = int(pd[:4]), int(pd[5:7]), int(pd[8:10])
            y1, m1, d1_ = int(dd[:4]), int(dd[5:7]), int(dd[8:10])
            g = (date(y1, m1, d1_) - date(y0, m0, d0)).days
        pd = dd
        out.append((dd, x[1], x[3], x[2], x[4], x[5], x[6], x[7], g))
    process(code, out)


buf = []
cur = None
q = """select code,date,open_qfq,close_qfq,high_qfq,low_qfq,vol,amount,close_raw
       from daily_kline where date>=? order by code,date"""
for r in conn.execute(q, ("2021-06-01",)):
    c = r[0]
    if c not in univ:
        continue
    if c != cur:
        if buf:
            flush(cur, buf)
        buf = []
        cur = c
    buf.append((r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], 0))
    if len(buf) > 1:
        pass
if buf:
    flush(cur, buf)
print("scan done", flush=1)


def pct(x):
    return "%.2f%%" % (x * 100)


def show():
    print("\n===== 三种卖出规则 x 条件组合（disc=1%/2%）=====")
    for dcv in DISCS:
        for cond in CONDS:
            for mode in MODES:
                s = stat[(dcv, cond, mode)]
                if not s["n"]:
                    continue
                wn = s["win"] / s["n"]
                aw = s["swin"] / s["win"] if s["win"] else 0
                nl = s["n"] - s["win"]
                al = s["slose"] / nl if nl else 0
                pr = abs(aw / al) if al else 0
                print("d=%.0f%% %-8s %-3s n=%7d 胜率=%5.1f%% 均盈=%5.2f%% 均亏=%5.2f%% 盈亏比=%4.2f 均收益=%6.3f%% 达标=%5.1f%% 最差=%6.2f%%"
                      % (dcv * 100, cond, mode, s["n"], wn * 100, aw * 100, al * 100, pr,
                         s["sret"] / s["n"] * 100, s["tgt"] / s["n"] * 100, s["worst"] * 100))

    print("\n===== 按天统计（disc=1%）=====")
    for cond in CONDS:
        for mode in MODES:
            dd = byday[(0.010, cond, mode)]
            if not dd:
                continue
            days = sorted(dd.items())
            dret = [v["sret"] / v["n"] for _, v in days]
            wins = sum(1 for x in dret if x > 0)
            cum, peak, mdd = 0.0, 0.0, 0.0
            for x in dret:
                cum += x
                peak = max(peak, cum)
                mdd = min(mdd, cum - peak)
            # 最长连亏天数
            ml = c = 0
            for x in dret:
                if x <= 0:
                    c += 1
                    ml = max(ml, c)
                else:
                    c = 0
            avg_n = sum(v["n"] for _, v in days) / len(days)
            print("%-8s %-3s 交易日=%4d 日均出手=%6.0f 盈利天占比=%5.1f%% 日均收益=%6.3f%% 累计=%7.1f%% 最大回撤=%6.1f%% 最长连亏=%d天"
                  % (cond, mode, len(days), avg_n, wins / len(days) * 100,
                     sum(dret) / len(dret) * 100, cum * 100, mdd * 100, ml))

    print("\n===== 大盘连跌天数曲线（disc=1%, 等回中间价）=====")
    for k in ["0", "1", "2", "3", "4", "5", "6", "7", "8+"]:
        s = fine[("downrun", k)]
        if not s["n"]:
            continue
        print("连跌=%2s天 n=%7d 胜率=%5.1f%% 均收益=%6.3f%% 达标=%5.1f%%"
              % (k, s["n"], s["win"] / s["n"] * 100, s["sret"] / s["n"] * 100, s["tgt"] / s["n"] * 100))

    print("\n===== 流动性分组（disc=1%, 等回中间价）=====")
    for k in ["<0.5亿", "0.5-1.5亿", "1.5-5亿", ">5亿"]:
        s = fine[("liq", k)]
        if not s["n"]:
            continue
        print("%-9s n=%7d 胜率=%5.1f%% 均收益=%6.3f%%" % (k, s["n"], s["win"] / s["n"] * 100, s["sret"] / s["n"] * 100))

    print("\n===== 回撤深度/平均振幅 比（disc=1%）=====")
    for k in ["浅", "深"]:
        s = fine[("amp", k)]
        if not s["n"]:
            continue
        print("%-4s n=%7d 胜率=%5.1f%% 均收益=%6.3f%%" % (k, s["n"], s["win"] / s["n"] * 100, s["sret"] / s["n"] * 100))


show()
