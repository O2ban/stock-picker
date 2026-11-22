#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""今日补充分析：开盘幅度分档 + 不同卖出方式"""
import gzip, json
from collections import defaultdict

FEE = 0.26
W_LO, W_HI = 575, 615

store = json.load(gzip.open('/tmp/tl_all.json.gz', 'rt', encoding='utf-8'))
S = []
for code, d in store.items():
    s, pts = d['s'], d['p']
    pc = s['prev']
    P = [p[1] for p in pts]
    if min(P) <= 0: continue
    hi = lo = P[0]
    mids = []
    for x in P:
        hi = max(hi, x); lo = min(lo, x)
        mids.append((hi + lo) / 2)
    S.append({'code': code, 'name': s['name'], 'pc': pc,
              'gap': (s['open'] / pc - 1) * 100, 'pts': pts, 'P': P,
              'mid': mids, 'vol': [p[2] for p in pts],
              'close': P[-1], 'chg': (P[-1] / pc - 1) * 100})

acc = defaultdict(list)
for x in S:
    for i, p in enumerate(x['P']):
        acc[i].append(x['close'] / p - 1)
BENCH = {i: sum(v) / len(v) for i, v in acc.items()}


def shrink_at(x, i, thr=0.8, win=5):
    if i < win: return None
    recent = sum(x['vol'][i - win + 1:i + 1]) / win
    hist = sum(x['vol'][:i + 1]) / (i + 1)
    return recent / hist if hist > 0 else None


def trigger(x):
    pc = x['pc']; P = x['P']; mid = x['mid']
    f5hi = max(P[:5])
    for i in range(5, len(P)):
        t = x['pts'][i][0]
        m = int(t[:2]) * 60 + int(t[2:])
        if m < W_LO: continue
        if m > W_HI: break
        p = P[i]
        if p < pc: continue
        if not (any(P[k] < pc for k in range(i)) or p > f5hi): continue
        if mid[i] < pc: continue
        r = shrink_at(x, i)
        if r is None or r >= 0.8: continue
        return i
    return None


def stat(label, arr, exg):
    if not arr: return
    n = len(arr); m = sum(arr)/n; e = sum(exg)/n
    sd = (sum((z-e)**2 for z in exg)/max(1,n-1))**0.5
    t = e/(sd/n**0.5) if sd > 0 else 0
    w = sum(1 for z in arr if z > 0)/n*100
    print(f'{label:30s}{n:5d} 只  毛{m:+6.2f}% 胜{w:3.0f}% 超额{e:+7.3f}%(t={t:+5.2f})')


print('=' * 88)
print('一、按开盘幅度分档（同样的买入形态）')
print('=' * 88)
buckets = [(-99, -2, '低开 2 个点以上'), (-2, -1, '低开 1~2 个点'), (-1, 0, '低开 1 个点内'),
           (0, 1, '高开 1 个点内'), (1, 1.5, '高开 1~1.5 个点'), (1.5, 99, '高开 1.5 个点以上')]
for lo, hi_, name in buckets:
    gross, exg = [], []
    for x in S:
        if not (lo <= x['gap'] < hi_): continue
        i = trigger(x)
        if i is None: continue
        g = (x['close'] / x['P'][i] - 1) * 100
        gross.append(g); exg.append(g - BENCH[i] * 100)
    stat(name, gross, exg)

print()
print('=' * 88)
print('二、不同卖出方式（同一批买入，全条件筛出）')
print('=' * 88)
for label, fn in [
    ('持到收盘', lambda x, i: x['close']),
    ('持到上午收盘 11:30', lambda x, i: x['P'][[k for k in range(len(x['P'])) if x['pts'][k][0] <= '1130'][-1]]),
    ('涨1%就卖 否则收盘', lambda x, i: next((x['P'][k] for k in range(i + 1, len(x['P']))
                                            if x['P'][k] / x['P'][i] - 1 >= 0.01), x['close'])),
    ('跌1%止损 否则收盘', lambda x, i: next((x['P'][k] for k in range(i + 1, len(x['P']))
                                            if x['P'][k] / x['P'][i] - 1 <= -0.01), x['close'])),
    ('赚1%卖/亏1%止损', lambda x, i: next((x['P'][k] for k in range(i + 1, len(x['P']))
                                          if abs(x['P'][k] / x['P'][i] - 1) >= 0.01), x['close'])),
]:
    gross, exg = [], []
    for x in S:
        i = trigger(x)
        if i is None: continue
        sp = fn(x, i)
        g = (sp / x['P'][i] - 1) * 100
        gross.append(g); exg.append(g - BENCH[i] * 100)
    stat(label, gross, exg)

print()
print('=' * 88)
print('三、今日筛出的票里，表现最好的前 10（说明形态最好时能到什么程度）')
print('=' * 88)
rows = []
for x in S:
    i = trigger(x)
    if i is None: continue
    rows.append((x['close'] / x['P'][i] * 100 - 100 - FEE, x['name'], x['code'],
                 x['pts'][i][0], round(x['gap'], 2), round(x['chg'], 2)))
rows.sort(reverse=True)
print(f'{"名称":12s}{"代码":9s}{"买点":>7s}{"开盘%":>8s}{"收盘%":>8s}{"净收益":>9s}')
for r, nm, cd, t, gap, chg in rows[:10]:
    print(f'{nm[:10]:12s}{cd:9s}{t:>7s}{gap:+8.2f}{chg:+8.2f}{r:+8.2f}%')
print(f'\n共筛出 {len(rows)} 只，赚 {sum(1 for r in rows if r[0]>0)} 只，'
      f'亏 {sum(1 for r in rows if r[0]<=0)} 只')
