#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""今日补充三：严格收敛版公式 —— 把数量压到可手工核对量级"""
import gzip, json
from collections import defaultdict

FEE = 0.26
W_LO, W_HI = 575, 620   # 9:35 ~ 10:20（允许拉回的容忍）

store = json.load(gzip.open('/tmp/tl_all.json.gz', 'rt', encoding='utf-8'))
S = []
for code, d in store.items():
    s, pts = d['s'], d['p']
    pc = s['prev']
    P = [p[1] for p in pts]
    if min(P) <= 0: continue
    if len(P) < 60: continue
    hi = lo = P[0]
    mids = []
    for x in P:
        hi = max(hi, x); lo = min(lo, x)
        mids.append((hi + lo) / 2)
    S.append({'code': code, 'name': s['name'], 'pc': pc,
              'gap': (s['open'] / pc - 1) * 100, 'pts': pts, 'P': P,
              'mid': mids, 'vol': [p[2] for p in pts],
              'close': P[-1], 'chg': (P[-1] / pc - 1) * 100})


def M(t): return int(t[:2]) * 60 + int(t[2:])


# 同分钟基准
acc = defaultdict(list)
for x in S:
    for i, p in enumerate(x['P']):
        acc[i].append(x['close'] / p - 1)
BENCH = {i: sum(v) / len(v) for i, v in acc.items()}


def stat(label, arr, exg):
    if not arr:
        print(f'{label:34s}    0 只'); return
    n = len(arr); m = sum(arr)/n; e = sum(exg)/n
    sd = (sum((z-e)**2 for z in exg)/max(1, n-1))**0.5
    t = e/(sd/n**0.5) if sd > 0 else 0
    w = sum(1 for z in arr if z > 0)/n*100
    print(f'{label:34s}{n:5d} 只  毛{m:+6.2f}% 胜{w:3.0f}% 超额{e:+7.3f}%(t={t:+5.2f})')


def vol_ratio(x, i, win=5):
    """触发时近 win 分钟均量 / 开盘到触发前的均量"""
    if i < win + 1: return None
    recent = sum(x['vol'][i-win+1:i+1]) / win
    base = sum(x['vol'][1:i-win+1]) / max(1, i-win)
    return recent / base if base > 0 else None


def strict_trigger(x, max_ret_water=600, need_shrink=None, need_vol_up=False,
                   need_above_prehigh=True, gap_lo=-2.0, gap_hi=1.5,
                   max_amp=7.0, max_chg_at_buy=5.0):
    """严格版：第一次从水下翻回水上的那一刻才买"""
    pc = x['pc']
    P = x['P']
    mid = x['mid']
    if not (gap_lo <= x['gap'] <= gap_hi): return None
    # 必须先真的跌破水面
    if not any(P[k] < pc for k in range(len(P))): return None
    # 第一次跌破的时刻，必须在设定时间前
    for i in range(1, len(P)):
        t = M(x['pts'][i][0])
        if P[i] < pc:
            if t > max_ret_water: return None   # 跌太晚，不算早盘洗盘
            break
    # 找第一次翻回水上的那一分钟
    for i in range(1, len(P)):
        t = M(x['pts'][i][0])
        if t > W_HI: return None
        if P[i] < pc: continue
        if P[i-1] >= pc: continue        # 只买"刚翻上来"那一刻
        if t < W_LO: continue
        # 到触发时为止的振幅
        amp = (max(P[:i+1]) / min(P[:i+1]) - 1) * 100
        if amp > max_amp: return None
        # 已经涨太多不追
        if (P[i] / pc - 1) * 100 > max_chg_at_buy: return None
        # 中在水上
        if mid[i] < pc: return None
        # 过 5 分钟前高
        if need_above_prehigh:
            k0 = max(0, i - 5)
            if P[i] <= max(P[k0:i]):
                return None
        r = vol_ratio(x, i)
        if need_vol_up:
            if r is None or r < 1.0: return None
        if need_shrink is not None:
            if r is None or r >= need_shrink: return None
        return i
    return None


print('=' * 92)
print('严格收敛版公式（第一次从水下翻回水上那一刻买，且形态各项加严）')
print('=' * 92)

configs = [
    ('① 只要求：早盘跌破+10点前翻回水上', dict(need_above_prehigh=False)),
    ('② ①+中在水上', dict(need_above_prehigh=False)),
    ('③ ②+过5分钟前高', dict()),
    ('④ ③+振幅<5%', dict(max_amp=5.0)),
    ('⑤ ③+买入时涨幅<3%', dict(max_chg_at_buy=3.0)),
    ('⑥ ③+缩量(<0.8)', dict(need_shrink=0.8)),
    ('⑦ ③+放量(>1.0)', dict(need_vol_up=True)),
    ('⑧ ③+放量>1.5', dict(need_vol_up=True, max_amp=7.0)),
    ('⑨ ③+振幅<5%+涨幅<3%', dict(max_amp=5.0, max_chg_at_buy=3.0)),
    ('⑩ ③+振幅<5%+涨幅<3%+放量>1.0', dict(max_amp=5.0, max_chg_at_buy=3.0, need_vol_up=True)),
]

best = None
for label, kw in configs:
    gross, exg = [], []
    for x in S:
        i = strict_trigger(x, **kw)
        if i is None: continue
        g = (x['close'] / x['P'][i] - 1) * 100
        gross.append(g); exg.append(g - BENCH[i] * 100)
    stat(label, gross, exg)

print()
print('=' * 92)
print('最严那一组剩下的票，逐只核对（今日实际表现，扣费后）')
print('=' * 92)
rows = []
for x in S:
    i = strict_trigger(x, max_amp=5.0, max_chg_at_buy=3.0, need_vol_up=True)
    if i is None: continue
    rows.append((x['close'] / x['P'][i] * 100 - 100 - FEE, x['name'], x['code'],
                 x['pts'][i][0], round(x['gap'], 2), round(x['chg'], 2),
                 round(x['P'][i], 2), round(x['close'], 2)))
rows.sort(reverse=True)
if rows:
    print(f'{"名称":12s}{"代码":9s}{"买点":>6s}{"开盘%":>8s}{"收盘%":>8s}{"买价":>8s}{"收价":>8s}{"净收益":>9s}')
    for r, nm, cd, t, gap, chg, bp, cp in rows:
        print(f'{nm[:10]:12s}{cd:9s}{t:>6s}{gap:+8.2f}{chg:+8.2f}{bp:8.2f}{cp:8.2f}{r:+8.2f}%')
    print(f'\n合计 {len(rows)} 只，赚 {sum(1 for r in rows if r[0]>0)} 只，亏 {sum(1 for r in rows if r[0]<=0)} 只')
else:
    print('0 只')

print()
print('=' * 92)
print('今日这批票里有没有 20cm 涨停的（看形态能不能抓到最猛的）')
print('=' * 92)
for x in S:
    i = strict_trigger(x, max_amp=5.0, max_chg_at_buy=3.0, need_vol_up=True)
    if i is None: continue
    if x['chg'] > 9.0:
        print(f"  {x['name']:12s}{x['code']:9s} 买点{x['pts'][i][0]} 收盘{x['chg']:+.2f}%")
