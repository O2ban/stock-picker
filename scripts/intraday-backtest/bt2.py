#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2 真实统计：清洗脏数据 + 同日胜率分布 + 大盘分组"""
import sqlite3, json, sys, os, random
from collections import defaultdict
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
DB = "/home/ubuntu/kline-trainer/kline-server/data/kline.db"
START = "2022-01-01"
WARM = "2021-06-01"
DISCS = (0.010, 0.020, 0.030)

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
    while j > 0 and idx_close[j] < idx_close[j - 1] and downrun < 10:
        downrun += 1
        j -= 1
    v20 = sum(idx_vol[i - 19:i + 1]) / 20
    return dict(d1=c0 / idx_close[i - 1] - 1,
                d5=c0 / idx_close[i - 5] - 1,
                d20=c0 / idx_close[i - 20] - 1,
                dev20=c0 / ma20 - 1,
                dev5=c0 / ma5 - 1,
                downrun=downrun,
                vr=(idx_vol[i] / v20 - 1) if v20 else 0)


stat = {dc: dict(n=0, win=0, sret=0.0, swin=0.0, slose=0.0, tgt=0) for dc in DISCS}
byday = {dc: defaultdict(lambda: dict(n=0, win=0, sret=0.0, tgt=0)) for dc in DISCS}
# 分大盘状态
byctx = {dc: defaultdict(lambda: dict(n=0, win=0, sret=0.0, tgt=0)) for dc in DISCS}
reasons = defaultdict(int)
obs = [0, 0]
gapsamp = []
prev_day = [None]


def process(code, rows):
    n = len(rows)
    if n < 80:
        return
    lim = limit_pct(code)
    for i in range(1, n - 1):
        d, o, h, c, l, vol, amt, craw, gap = rows[i]
        if d < START:
            continue
        if not o or not h or not l or not c or l <= 0 or not vol:
            continue
        d1, do, dh, dc_, dl = rows[i - 1][0], rows[i - 1][1], rows[i - 1][2], rows[i - 1][3], rows[i - 1][4]
        if not dh or not dl or not dc_:
            continue
        mid = (dh + dl) / 2.0
        obs[0] += 1
        if h > mid:
            obs[1] += 1
        if random.random() < 0.01:
            avgpx = amt / (vol * 100.0)
            if avgpx > 0:
                gapsamp.append(mid / avgpx - 1)

        if gap > 15:
            reasons["停牌断层"] += 1
            continue
        if amt < 3e7:
            reasons["成交清淡"] += 1
            continue
        chg = c / dc_ - 1
        if chg <= -(lim - 0.004) and c <= l * 1.002:
            reasons["跌停封死"] += 1
            continue
        ctx = idx_ctx(d)
        if ctx is None:
            continue
        no, nh, nc = rows[i + 1][1], rows[i + 1][2], rows[i + 1][3]
        if not no or not nh or not nc:
            reasons["次日无数据"] += 1
            continue

        for dcv in DISCS:
            if c > mid * (1 - dcv):
                continue
            if nh >= mid:
                sell, ek = mid, 1
            else:
                sell, ek = nc, 0
            ret = sell / c - 1
            if abs(ret) > 0.45:
                reasons["异常收益"] += 1
                continue
            s = stat[dcv]
            s["n"] += 1
            s["sret"] += ret
            if ek:
                s["tgt"] += 1
            if ret > 0:
                s["win"] += 1
                s["swin"] += ret
            else:
                s["slose"] += ret
            b = byday[dcv][d]
            b["n"] += 1
            b["sret"] += ret
            if ek:
                b["tgt"] += 1
            if ret > 0:
                b["win"] += 1
            if ctx["downrun"] == 0:
                k = "大盘连跌0天"
            elif ctx["downrun"] <= 2:
                k = "大盘连跌1-2天"
            elif ctx["downrun"] <= 5:
                k = "大盘连跌3-5天"
            else:
                k = "大盘连跌6天+"
            g = byctx[dcv][k]
            g["n"] += 1
            g["sret"] += ret
            if ek:
                g["tgt"] += 1
            if ret > 0:
                g["win"] += 1


cur = conn.execute(
    "select code,date,open_qfq,close_qfq,high_qfq,low_qfq,vol,amount,close_raw "
    "from daily_kline where date>=? order by code,date", (WARM,))
prev_code = None
buf = []
cnt = 0


def flush(code, buf):
    if not buf:
        return
    out = []
    pd = None
    for x in buf:
        dd = x[0]
        cur_d = date(int(dd[:4]), int(dd[5:7]), int(dd[8:10]))
        g = 0
        if pd is not None:
            g = (cur_d - pd).days
        out.append((dd, x[1], x[3], x[2], x[4], x[5], x[6], x[7], g))
        pd = cur_d
    process(code, out)


for r in cur:
    code = r[0]
    if code not in univ:
        continue
    if code != prev_code:
        flush(prev_code, buf)
        buf = []
        prev_code = code
        cnt += 1
        if cnt % 500 == 0:
            print(f"  {cnt}", file=sys.stderr, flush=True)
    buf.append((r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[0]))
flush(prev_code, buf)

print("=" * 74)
print("剔除统计:", dict(reasons))
print("今日最高>昨日中间价: %.4f%% (%d/%d)" % (obs[1] / obs[0] * 100, obs[1], obs[0]))
if gapsamp:
    gapsamp.sort()
    m = len(gapsamp)
    print("昨日中间价 vs 今日均价: 中位偏差=%.3f%% |偏差|<1%%占比=%.2f%% <2%%占比=%.2f%%" % (
        gapsamp[m // 2] * 100,
        sum(1 for x in gapsamp if abs(x) < 0.01) / m * 100,
        sum(1 for x in gapsamp if abs(x) < 0.02) / m * 100))
print("-" * 74)
for dcv in DISCS:
    s = stat[dcv]
    n = s["n"]
    wr = s["win"] / n
    avg = s["sret"] / n
    aw = s["swin"] / s["win"] if s["win"] else 0
    al = s["slose"] / (n - s["win"]) if n > s["win"] else 0
    print(f"折扣>{dcv:.0%}: n={n} 胜率={wr:.2%} 均收益={avg:+.3%} 均盈={aw:+.2%} "
          f"均亏={al:+.2%} 盈亏比={abs(aw/al) if al else 0:.2f} 达标率={s['tgt']/n:.2%}")

print("-" * 74)
for dcv in DISCS:
    print(f"【折扣 {dcv:.0%}】按当日出手数量分组（同日胜率）")
    days = byday[dcv]
    buckets = defaultdict(lambda: dict(n=0, win=0, days=0, sret=0.0))
    for d, v in days.items():
        if v["n"] >= 50:
            k = "同日≥50只"
        elif v["n"] >= 20:
            k = "同日20-49只"
        elif v["n"] >= 5:
            k = "同日5-19只"
        else:
            k = "同日<5只"
        b = buckets[k]
        b["n"] += v["n"]
        b["win"] += v["win"]
        b["days"] += 1
        b["sret"] += v["sret"]
    for k in ("同日<5只", "同日5-19只", "同日20-49只", "同日≥50只"):
        if k in buckets:
            b = buckets[k]
            print(f"  {k}: 交易日={b['days']} 笔数={b['n']} 笔均胜率={b['win']/b['n']:.2%} "
                  f"日均笔数={b['n']/b['days']:.1f} 均收益={b['sret']/b['n']:+.3%}")
    dn = len(days)
    print(f"  合计：有信号交易日={dn} / 总交易日≈{len([d for d in idx_dates if d>=START])}")

print("-" * 74)
for dcv in DISCS:
    print(f"【折扣 {dcv:.0%}】按大盘连跌天数分组")
    for k, g in sorted(byctx[dcv].items()):
        if g["n"] < 200:
            continue
        print(f"  {k}: 笔数={g['n']} 胜率={g['win']/g['n']:.2%} 均收益={g['sret']/g['n']:+.3%} "
              f"达标率={g['tgt']/g['n']:.2%}")

json.dump({
    "stat": {str(k): v for k, v in stat.items()},
    "byday": {str(k): dict(v) for k, v in byday.items()},
    "byctx": {str(k): dict(v) for k, v in byctx.items()},
    "idx": {d: idx_ctx(d) for d in idx_dates if idx_ctx(d)},
}, open(os.path.join(HERE, "agg2.json"), "w"))
print("saved agg2.json")
