#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基线：日线近似回测「昨日中间价下方低吸 -> 次日回归中间价卖出」
流式单次扫描，避免反复走索引。
口径A：盘中最低跌穿 昨中间价*0.99 即以该价挂单成交（乐观，可能事后看）
口径B：当日收盘价仍在该价位下方，则以收盘价买入（保守，可实盘执行）
卖出：次日最高 >= 昨中间价 则以昨中间价卖出；否则次日收盘卖出。
"""
import sqlite3, json, sys, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DB = "/home/ubuntu/kline-trainer/kline-server/data/kline.db"
START = "2022-01-01"
WARM = "2021-06-01"

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

idx = {}
for d, o, c, h, l, v in json.load(open(os.path.join(HERE, "idx_sh.json")))["data"]["sh000001"]["day"]:
    idx[d] = (float(o), float(c), float(h), float(l))
idx_dates = sorted(idx.keys())
idx_close = [idx[d][1] for d in idx_dates]
idx_pos = {d: i for i, d in enumerate(idx_dates)}

_ctx_cache = {}


def idx_ctx(d):
    if d in _ctx_cache:
        return _ctx_cache[d]
    i = idx_pos.get(d)
    if i is None or i < 25:
        _ctx_cache[d] = None
        return None
    c0 = idx_close[i]
    r = (c0 / idx_close[i - 1] - 1,
         c0 / idx_close[i - 5] - 1,
         c0 / (sum(idx_close[i - 19:i + 1]) / 20) - 1,
         (sum(idx_close[i - 19:i + 1]) / 20) / (sum(idx_close[i - 24:i - 4]) / 20) - 1)
    _ctx_cache[d] = r
    return r


results = []
obs_tot = obs_hit = 0
prev_code = None
buf = []


def process(codename, rows):
    global obs_tot, obs_hit
    code, name = codename
    n = len(rows)
    if n < 80:
        return
    closes = [r[3] for r in rows]
    ma5 = [0.0] * n
    ma20 = [0.0] * n
    s5 = s20 = 0.0
    for i in range(n):
        s5 += closes[i]
        s20 += closes[i]
        if i >= 5:
            s5 -= closes[i - 5]
        if i >= 20:
            s20 -= closes[i - 20]
        ma5[i] = s5 / 5 if i >= 4 else 0.0
        ma20[i] = s20 / 20 if i >= 19 else 0.0
    for i in range(1, n - 1):
        d = rows[i][0]
        if d < START:
            continue
        o, h, l, c, vol, amt = rows[i][1], rows[i][2], rows[i][3], rows[i][4], rows[i][5], rows[i][6]
        if not o or not h or not l or not c or l <= 0:
            continue
        ph, pl, pc = rows[i - 1][2], rows[i - 1][4], rows[i - 1][3]
        if not ph or not pl:
            continue
        mid = (ph + pl) / 2.0
        obs_tot += 1
        if h > mid:
            obs_hit += 1
        ctx = idx_ctx(d)
        if ctx is None:
            continue
        if amt < 3e7:
            continue
        disc = mid * 0.99
        if l > disc:
            continue
        nxt = rows[i + 1]
        no, nh, nl, nc = nxt[1], nxt[2], nxt[4], nxt[3]
        if not no or not nh or not nc:
            continue
        base = dict(code=code, name=name, date=d, mid=mid, close=c,
                    ma5=ma5[i], ma5p=ma5[i - 4], ma20=ma20[i],
                    d1=ctx[0], d5=ctx[1], dev20=ctx[2], slope20=ctx[3],
                    amt=amt, lowdepth=(mid - l) / mid,
                    amp=(h - l) / pc if pc else 0)
        for tag, buy in (("A", disc), ("B", (c if c <= disc else None))):
            if buy is None:
                continue
            if nh >= mid:
                sell, ek = mid, "target"
            else:
                sell, ek = nc, "close"
            r = dict(base)
            r.update(tag=tag, buy=buy, sell=sell, ret=sell / buy - 1, exit=ek)
            results.append(r)


cur = conn.execute(
    "select k.code,k.date,k.open_qfq,k.close_qfq,k.high_qfq,k.low_qfq,k.vol,k.amount "
    "from daily_kline k where k.date>=? order by k.code,k.date", (WARM,))
cnt = 0
for r in cur:
    code = r[0]
    if code not in univ:
        prev_code = code
        buf = []
        continue
    if code != prev_code:
        if buf:
            process((prev_code, univ[prev_code]), buf)
            cnt += 1
            if cnt % 1000 == 0:
                print(f"  stock {cnt}, trades {len(results)}", file=sys.stderr)
        buf = []
        prev_code = code
    buf.append((r[1], r[2], r[4], r[3], r[5], r[6], r[7]))  # date,open,high,close,low,vol,amt
if buf:
    process((prev_code, univ[prev_code]), buf)

json.dump(results, open(os.path.join(HERE, "trades_baseline.json"), "w"))
print("obs: 今日最高>昨日中间价 比例 %.4f (%d/%d)" % (obs_hit / obs_tot, obs_hit, obs_tot))
print("trades:", len(results), f"stocks {cnt}")


def summarize(rs, label):
    if not rs:
        print(f"{label}: 无交易")
        return
    n = len(rs)
    wins = [x["ret"] for x in rs if x["ret"] > 0]
    ls = [x["ret"] for x in rs if x["ret"] <= 0]
    wr = len(wins) / n
    avg = sum(x["ret"] for x in rs) / n
    aw = sum(wins) / len(wins) if wins else 0
    al = sum(ls) / len(ls) if ls else 0
    pf = (sum(wins) / abs(sum(ls))) if ls and sum(ls) != 0 else float("inf")
    tgt = sum(1 for x in rs if x["exit"] == "target") / n
    days = len(set(x["date"] for x in rs))
    print(f"{label}: n={n} 交易日={days} 胜率={wr:.2%} 均收益={avg:.3%} 均盈={aw:.2%} "
          f"均亏={al:.2%} 盈亏比={pf:.2f} 最差={min(ls) if ls else 0:.2%} 达标率={tgt:.2%}")


for tag in ("A", "B"):
    summarize([x for x in results if x["tag"] == tag], f"基线 口径{tag}")
