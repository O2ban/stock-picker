#!/usr/bin/env python3
# 止损放宽明细对比：tp3 配合 sl1/2/3/4，看清楚出场结构怎么变
import os, csv, glob
from collections import defaultdict

CSV_DIR = "/home/ubuntu/stock-picker/data/min5_pool"
FEE = 0.26
AMP_THR = 3.0
AMP_DAYS = 3
BODY_MAX = 1.0

def load_min5(p):
    days = defaultdict(list)
    with open(p, newline='') as f:
        for row in csv.reader(f):
            if len(row) < 7: continue
            d = row[0].replace('-','')
            if len(d) != 8 or not d.isdigit(): continue
            try:
                o,h,l,c = float(row[2]),float(row[3]),float(row[4]),float(row[5])
            except: continue
            days[d].append((o,h,l,c))
    out = []
    for d in sorted(days):
        bars = days[d]
        out.append((d, bars))
    return out

def agg_daily(days):
    res = []
    for d, bars in days:
        o = bars[0][0]; c = bars[-1][3]
        h = max(b[1] for b in bars); l = min(b[2] for b in bars)
        res.append((d,o,h,l,c))
    return res

def ma(vals, n):
    out=[None]*len(vals)
    s=0.0
    for i,v in enumerate(vals):
        s+=v
        if i>=n: s-=vals[i-n]
        if i>=n-1: out[i]=s/n
    return out

def simulate_next(day_bars, buy, tp, sl):
    # 返回 (收益%, 出场原因)
    tp_p = buy*(1+tp/100.0)
    sl_p = buy*(1-sl/100.0)
    first = day_bars[0]
    if first[0] >= tp_p: return (first[0]/buy-1)*100, 'T跳空'
    if first[0] <= sl_p: return (first[0]/buy-1)*100, 'S跳空'
    for (o,h,l,c) in day_bars:
        hit_t = h >= tp_p
        hit_s = l <= sl_p
        if hit_s and hit_t:
            return -sl, 'S同根'
        if hit_s:
            return -sl, 'S止损'
        if hit_t:
            return tp, 'T止盈'
    last = day_bars[-1][3]
    return (last/buy-1)*100, '收盘平'

def run(tp, sl):
    total=0; wins=0; ssum=0.0; exits=defaultdict(int)
    for p in sorted(glob.glob(os.path.join(CSV_DIR,'*.csv'))):
        days = load_min5(p)
        if len(days) < 120: continue
        dl = agg_daily(days)
        closes=[x[4] for x in dl]
        ma5=ma(closes,5); ma20=ma(closes,20)
        n=len(dl)
        for i in range(21, n-1):
            ok=True
            for k in range(AMP_DAYS):
                j=i-k
                d,o,h,l,c = dl[j]
                if c<=0: ok=False;break
                if (h-l)/c*100 <= AMP_THR: ok=False;break
                if ma5[j] is None or ma20[j] is None: ok=False;break
                if c <= ma5[j] or c <= ma20[j]: ok=False;break
            if not ok: continue
            d,o,h,l,c = dl[i]
            prev = dl[i-1][4]
            if abs(c-o)/prev*100 > BODY_MAX: continue
            if d not in dict(days): continue
            nxt = dict(days).get(dl[i+1][0])
            if not nxt: continue
            # 次日开盘买（避免收盘买的系统性高估，这里给两种都算）
            buy = nxt[0][0]
            r, why = simulate_next(nxt, buy, tp, sl)
            net = r - FEE
            total+=1; ssum+=net; exits[why]+=1
            if net>0: wins+=1
    return total, wins, ssum/total if total else 0, ssum, exits

print(f"{'组合':<12}{'次数':>7}{'胜率':>9}{'扣费均值':>11}{'合计':>9}")
for tp,sl in [(3,1),(3,2),(3,3),(3,4),(3,5)]:
    n,w,avg,tot,ex = run(tp,sl)
    print(f"tp{tp}/sl{sl:<6}{n:>7}{w/n*100:>8.1f}%{avg:>10.3f}%{tot:>8.1f}%")
    print(f"   出场: " + "  ".join(f"{k}{v}({v/n*100:.0f}%)" for k,v in sorted(ex.items(), key=lambda x:-x[1])))
