#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
单票日内低吸回测 v1
规则：
 - 完全用 5 分钟数据自聚合出日线(OHLC)，保证复权基准自洽
 - amp60: 60日平均振幅 = mean((high-low)/prev_close)
 - ma5: 5日均线(收盘)
 - 不交易条件: 前一日收盘 <= 前一日ma5
 - 触发价 trig = prev_close * (1 - k*amp60)，当日5分钟bar最低价 <= trig 即买入
 - 买入价 = 触发的bar的收盘价(保守)
 - 卖出: 次日多种策略对比
"""
import json, os, sys, statistics
from collections import defaultdict

D = os.path.dirname(os.path.abspath(__file__))
M5 = os.path.join(D, 'min5')

KS = [0.6, 0.8, 1.0, 1.2]
SELLS = ['next_open', 'next_close', 'tp1', 'tp2', 'mid']


def load_daily(path):
    """从5分钟数据聚合日线"""
    with open(path) as f:
        rows = json.load(f)
    # row: [date, time, open, high, low, close, volume]
    byday = defaultdict(list)
    for r in rows:
        byday[r[0]].append([r[0], r[1], float(r[2]), float(r[3]), float(r[4]),
                            float(r[5]), float(r[6])])
    days = []
    for d in sorted(byday.keys()):
        bars = sorted(byday[d], key=lambda x: x[1])
        o = bars[0][2]
        h = max(b[3] for b in bars)
        l = min(b[4] for b in bars)
        c = bars[-1][5]
        v = sum(b[6] for b in bars)
        days.append({'date': d, 'o': o, 'h': h, 'l': l, 'c': c, 'v': v, 'bars': bars})
    return days


def run_one(path, name):
    days = load_daily(path)
    n = len(days)
    res = {k: {s: [] for s in SELLS} for k in KS}
    res2 = {k: {s: [] for s in SELLS} for k in KS}   # 两日振幅口径
    ntrig_days = 0
    ntrail_days = 0

    # 预计算振幅与均线
    amp1 = [None] * n
    amp2 = [None] * n
    ma5 = [None] * n
    for i in range(1, n):
        pc = days[i - 1]['c']
        if pc > 0:
            amp1[i] = (days[i]['h'] - days[i]['l']) / pc
    # 两日振幅: 当日与前一日的最高最低跨度 / 前前日收盘
    for i in range(2, n):
        pp = days[i - 2]['c']
        if pp > 0:
            hi = max(days[i]['h'], days[i - 1]['h'])
            lo = min(days[i]['l'], days[i - 1]['l'])
            amp2[i] = (hi - lo) / pp
    for i in range(4, n):
        cs = [days[j]['c'] for j in range(i - 4, i + 1)]
        ma5[i] = sum(cs) / 5.0

    amp60_1 = [None] * n
    amp60_2 = [None] * n
    for i in range(60, n):
        vals = [amp1[j] for j in range(i - 59, i + 1) if amp1[j] is not None]
        if len(vals) >= 40:
            amp60_1[i] = sum(vals) / len(vals)
        vals2 = [amp2[j] for j in range(i - 59, i + 1) if amp2[j] is not None]
        if len(vals2) >= 40:
            amp60_2[i] = sum(vals2) / len(vals2)

    for i in range(62, n - 1):
        if ma5[i - 1] is None:
            continue
        if days[i - 1]['c'] <= ma5[i - 1]:
            ntrail_days += 1
            continue
        pc = days[i - 1]['c']
        nxt = days[i + 1]
        mid = (days[i]['h'] + days[i]['l']) / 2.0   # 买入日的中间价

        for tag, amp60 in ((1, amp60_1), (2, amp60_2)):
            a = amp60[i]
            if a is None or a <= 0:
                continue
            for k in KS:
                trig = pc * (1 - k * a)
                if days[i]['l'] > trig:
                    continue
                # 找第一根触发的bar
                hit = False
                for b in days[i]['bars']:
                    if b[4] <= trig:
                        hit = True
                        break
                if not hit:
                    continue
                buy = trig   # 限价单按触发价成交
                tgt = {x: {s: None for s in SELLS} for x in (1, 2)}[tag]
                rec = {s: None for s in SELLS}
                rec['next_open'] = nxt['o'] / buy - 1
                rec['next_close'] = nxt['c'] / buy - 1
                # 次日盘中触及目标
                for s, tp in (('tp1', buy * 1.01), ('tp2', buy * 1.02), ('mid', mid)):
                    hit = False
                    for b in nxt['bars']:
                        if b[3] >= tp:
                            hit = True
                            break
                    rec[s] = (tp / buy - 1) if hit else (nxt['c'] / buy - 1)
                if tag == 1:
                    for s in SELLS:
                        res[k][s].append(rec[s])
                    if k == 1.0:
                        ntrig_days += 1
                else:
                    for s in SELLS:
                        res2[k][s].append(rec[s])
    return res, res2, ntrig_days, ntrail_days, n


def stat(v):
    if not v:
        return None
    w = [x for x in v if x > 0]
    l = [x for x in v if x <= 0]
    win = len(w) / len(v) * 100
    aw = sum(w) / len(w) * 100 if w else 0
    al = sum(l) / len(l) * 100 if l else 0
    exp = sum(v) / len(v) * 100
    pf = (aw * len(w)) / abs(al * len(l)) if l and al != 0 else float('inf')
    return len(v), win, aw, al, pf, exp


def main():
    files = sorted(os.listdir(M5))
    tot1 = {k: {s: [] for s in SELLS} for k in KS}
    tot2 = {k: {s: [] for s in SELLS} for k in KS}
    print(f'{"="*108}')
    for f in files:
        if not f.endswith('.json'):
            continue
        name = f.replace('.json', '')
        r1, r2, nd, ntd, n = run_one(os.path.join(M5, f), name)
        print(f'\n【{name}】交易日 {n} 天，5日线下方(不交易) {ntd} 天，触发买入 {nd} 天')
        for tag, rr, lbl in ((1, r1, '单日振幅'), (2, r2, '两日振幅')):
            for k in KS:
                line = f'  {lbl} k={k:>3}: '
                for s in SELLS:
                    st = stat(rr[k][s])
                    if st:
                        line += f'{s}[n={st[0]} 胜{st[1]:.1f}% 均{st[5]:+.3f}% PF{st[4]:.2f}] '
                print(line)
        for tag, rr in ((1, tot1), (2, tot2)):
            for k in KS:
                for s in SELLS:
                    rr[k][s].extend((r1 if tag == 1 else r2)[k][s])

    print(f'\n{"="*108}\n【8只合计】')
    for tag, tt, lbl in ((1, tot1, '单日振幅'), (2, tot2, '两日振幅')):
        print(f'-- {lbl} --')
        for k in KS:
            for s in SELLS:
                st = stat(tt[k][s])
                if st:
                    print(f'  k={k:<4} {s:<11} n={st[0]:<6} 胜率{st[1]:>5.1f}% 均盈{st[2]:+.2f}% 均亏{st[3]:+.2f}% PF={st[4]:>5.2f} 期望{st[5]:+.3f}%')


if __name__ == '__main__':
    main()
