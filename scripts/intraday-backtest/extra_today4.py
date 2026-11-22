#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""正确口径：策略层用规则 R 卖，基准也必须用规则 R 卖"""
import gzip, json
from collections import defaultdict

FEE = 0.26
W_LO, W_HI = 575, 620

store = json.load(gzip.open('/tmp/tl_all.json.gz', 'rt', encoding='utf-8'))
S = []
for code, d in store.items():
    s, pts = d['s'], d['p']
    pc = s['prev']
    P = [p[1] for p in pts]
    if min(P) <= 0 or len(P) < 60: continue
    hi = lo = P[0]
    mids = []
    for x in P:
        hi = max(hi, x); lo = min(lo, x)
        mids.append((hi + lo) / 2)
    S.append({'code': code, 'name': s['name'], 'pc': pc,
              'gap': (s['open']/pc - 1)*100, 'pts': pts, 'P': P, 'mid': mids,
              'vol': [p[2] for p in pts], 'close': P[-1], 'chg': (P[-1]/pc-1)*100})

BENCH = {k: {int(i): v for i, v in d.items()}
         for k, d in json.load(open('/tmp/bench_rules.json')).items()}

RULES = {
    '持到收盘': lambda P, i: P[-1],
    '赚1%止盈': lambda P, i: next((P[k] for k in range(i+1, len(P)) if P[k]/P[i]-1 >= 0.01), P[-1]),
    '亏1%止损': lambda P, i: next((P[k] for k in range(i+1, len(P)) if P[k]/P[i]-1 <= -0.01), P[-1]),
    '赚1%或亏1%': lambda P, i: next((P[k] for k in range(i+1, len(P)) if abs(P[k]/P[i]-1) >= 0.01), P[-1]),
}


def trail(P, i, back=0.01):
    peak = P[i]
    for k in range(i+1, len(P)):
        peak = max(peak, P[k])
        if P[k]/peak - 1 <= -back: return P[k]
    return P[-1]


RULES['回撤1%卖'] = trail


def M(t): return int(t[:2])*60 + int(t[2:])


def vol_ratio(x, i, win=5):
    if i < win + 1: return None
    recent = sum(x['vol'][i-win+1:i+1])/win
    base = sum(x['vol'][1:i-win+1])/max(1, i-win)
    return recent/base if base > 0 else None


def trig(x, req=None):
    """req=None 完整条件；'gongshi' 宽松公式"""
    pc = x['pc']; P = x['P']; mid = x['mid']
    if not (-2.0 <= x['gap'] <= 1.5): return None
    for i in range(5, len(P)):
        t = M(x['pts'][i][0])
        if t > W_HI: return None
        if P[i] < pc: continue
        if P[i-1] >= pc: continue
        if t < W_LO: continue
        if mid[i] < pc: return None if req == 'strict' else None
        r = vol_ratio(x, i)
        if req == 'strict':
            if r is None or r < 1.0: continue
            if (max(P[:i+1])/min(P[:i+1])-1)*100 > 5: continue
            if (P[i]/pc-1)*100 > 3: continue
            if P[i] <= max(P[max(0, i-5):i]): continue
        else:
            if r is None or r >= 0.8: continue
        return i
    return None


def stat(label, arr, exg):
    if not arr:
        print(f'{label:26s}    0 只'); return
    n = len(arr); m = sum(arr)/n; e = sum(exg)/n
    sd = (sum((z-e)**2 for z in exg)/max(1, n-1))**0.5
    t = e/(sd/n**0.5) if sd > 0 else 0
    w = sum(1 for z in arr if z > 0)/n*100
    print(f'{label:26s}{n:5d} 只  毛{m:+6.2f}% 胜{w:3.0f}% 超额{e:+7.3f}%(t={t:+5.2f})')


for mode, mlabel in [('gongshi', '宽松公式（缩量<0.8）'), ('strict', '严格公式（放量+振幅<5%+涨幅<3%+过前高）')]:
    print('=' * 88)
    print(mlabel)
    print('=' * 88)
    picks = []
    for x in S:
        i = trig(x, mode)
        if i is not None: picks.append((x, i))
    print(f'筛出 {len(picks)} 只')
    print(f'{"卖出规则":26s}{"":5s}     策略毛收益            同规则全市场基准      超额')
    for name, fn in RULES.items():
        gross, exg = [], []
        for x, i in picks:
            P = x['P']
            g = (fn(P, i)/P[i]-1)*100
            b = BENCH[name].get(i, 0)
            gross.append(g); exg.append(g - b*100)
        stat(name, gross, exg)
    print()
