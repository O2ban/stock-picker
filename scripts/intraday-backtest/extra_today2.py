#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""今日补充分析二：涨停占比 + 移动止盈 + 排除涨停后剩余"""
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


def shrink_at(x, i, win=5):
    if i < win: return None
    recent = sum(x['vol'][i - win + 1:i + 1]) / win
    hist = sum(x['vol'][:i + 1]) / (i + 1)
    return recent / hist if hist > 0 else None


def trigger(x, need_mid=True, need_shrink=True, need_shake=True):
    pc = x['pc']; P = x['P']; mid = x['mid']
    f5hi = max(P[:5])
    for i in range(5, len(P)):
        t = x['pts'][i][0]
        m = int(t[:2]) * 60 + int(t[2:])
        if m < W_LO: continue
        if m > W_HI: break
        p = P[i]
        if p < pc: continue
        below = any(P[k] < pc for k in range(i))
        if not (below or p > f5hi): continue
        if need_mid and mid[i] < pc: continue
        if need_shake and not below: continue
        if need_shrink:
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
    print(f'{label:28s}{n:5d} 只  毛{m:+6.2f}% 胜{w:3.0f}% 超额{e:+7.3f}%(t={t:+5.2f})')


def limit_pct(code):
    return 20.0 if code[:3] in ('sz30', 'sh68') else 10.0


picks = []
for x in S:
    i = trigger(x)
    if i is not None:
        picks.append((x, i))

n = len(picks)
lu = [(x, i) for x, i in picks if x['chg'] >= limit_pct(x['code']) - 0.6]
print('=' * 88)
print(f'公式筛出 {n} 只；其中当日涨停/接近涨停 {len(lu)} 只，占 {len(lu)/n*100:.1f}%')
print(f'全市场 3737 只当日涨停约 {sum(1 for x in S if x["chg"] >= limit_pct(x["code"]) - 0.6)} 只，'
      f'命中率 {len(lu)/max(1,sum(1 for x in S if x["chg"] >= limit_pct(x["code"]) - 0.6))*100:.1f}%')
print('=' * 88)
print('涨停票平均收益 vs 非涨停票')
lu_r = [(x['close'] / x['P'][i] - 1) * 100 for x, i in lu]
no_r = [(x['close'] / x['P'][i] - 1) * 100 for x, i in picks if x['chg'] < limit_pct(x['code']) - 0.6]
print(f'  涨停组 {len(lu):4d} 只 毛 {sum(lu_r)/max(1,len(lu_r)):+.2f}%')
print(f'  非涨停 {len(no_r):4d} 只 毛 {sum(no_r)/max(1,len(no_r)):+.2f}%')

print()
print('=' * 88)
print('不同卖出规则（全条件筛出的同一批）')
print('=' * 88)


def sell_close(x, i): return x['close']
def sell_tp(x, i, tp=0.01):
    return next((x['P'][k] for k in range(i+1, len(x['P'])) if x['P'][k]/x['P'][i]-1 >= tp), x['close'])
def sell_sl(x, i, sl=0.01):
    return next((x['P'][k] for k in range(i+1, len(x['P'])) if x['P'][k]/x['P'][i]-1 <= -sl), x['close'])
def sell_trail(x, i, back=0.01):
    peak = x['P'][i]
    for k in range(i+1, len(x['P'])):
        p = x['P'][k]
        peak = max(peak, p)
        if p / peak - 1 <= -back: return p
    return x['close']
def sell_trail_profit(x, i, trig=0.02, back=0.01):
    """涨过 2% 才开始跟踪，回撤 1% 卖；没涨过就收盘卖"""
    peak = x['P'][i]
    armed = False
    for k in range(i+1, len(x['P'])):
        p = x['P'][k]
        peak = max(peak, p)
        if peak / x['P'][i] - 1 >= trig: armed = True
        if armed and p / peak - 1 <= -back: return p
    return x['close']


for label, fn in [
    ('持到收盘', sell_close),
    ('赚1%止盈', sell_tp),
    ('亏1%止损', sell_sl),
    ('从最高回撤1%卖', sell_trail),
    ('赚2%后回撤1%卖', sell_trail_profit),
    ('赚3%后回撤1.5%卖', lambda x, i: sell_trail_profit(x, i, 0.03, 0.015)),
]:
    gross, exg = [], []
    for x, i in picks:
        g = (fn(x, i) / x['P'][i] - 1) * 100
        gross.append(g); exg.append(g - BENCH[i] * 100)
    stat(label, gross, exg)

print()
print('=' * 88)
print('剔除涨停票后，剩下的票还有没有超额（判断是不是只靠抓涨停）')
print('=' * 88)
for label, cond in [('全部筛出', lambda x: True),
                    ('剔除涨停票', lambda x: x['chg'] < limit_pct(x['code']) - 0.6)]:
    gross, exg = [], []
    for x, i in picks:
        if not cond(x): continue
        g = (x['close'] / x['P'][i] - 1) * 100
        gross.append(g); exg.append(g - BENCH[i] * 100)
    stat(label, gross, exg)
