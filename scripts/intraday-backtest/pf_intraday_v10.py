#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v10：在超额口径下统一检验「量能」两种定义，避免口径打架。
A) 量比 = 入场前开盘以来均量 / 前5日同跨度均量（只用到入场前信息）
B) 回踩缩量比（水下均量/首根量）
"""
import os, glob, csv, math

FEE = 0.26
POOL = '/home/ubuntu/stock-picker/data/min5_pool/'
BIG = '/home/ubuntu/stock-picker/data/min5/'


def load_csv(path):
    days, order = {}, []
    for row in csv.reader(open(path, encoding='utf-8', errors='ignore')):
        if len(row) < 8: continue
        d = row[0].strip()
        try: v = (float(row[2]), float(row[3]), float(row[4]), float(row[5]), float(row[6]))
        except ValueError: continue
        if d not in days: days[d] = []; order.append(d)
        days[d].append(v)
    return {d: days[d] for d in order}


def load_ndjson(path):
    days, order = {}, []
    for line in open(path, encoding='utf-8', errors='ignore'):
        p = line.strip().split(',')
        if len(p) < 7: continue
        d = p[0][:8]
        try: v = (float(p[1]), float(p[2]), float(p[3]), float(p[4]), float(p[5]))
        except ValueError: continue
        if d not in days: days[d] = []; order.append(d)
        days[d].append(v)
    return {d: days[d] for d in order}


def M(v): return sum(v) / len(v) if v else float('nan')
def tstat(v):
    if len(v) < 5: return 0.0
    m = M(v); sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    return m / (sd / math.sqrt(len(v))) if sd > 0 else 0.0


DATA = {}
for fp in sorted(glob.glob(POOL + '*.csv')):
    DATA[os.path.basename(fp)[:-4]] = ('small', load_csv(fp))
for fp in sorted(glob.glob(BIG + '*.ndjson')):
    DATA[os.path.basename(fp).split('.')[0]] = ('big', load_ndjson(fp))

BASE = {}
for code, (pool, days) in DATA.items():
    for d, bars in days.items():
        if len(bars) < 40: continue
        BASE.setdefault((d, pool), []).append((bars[-1][3] / bars[0][3] - 1) * 100 - FEE)
BASE = {k: M(v) for k, v in BASE.items()}

rows = []
for code, (pool, days) in DATA.items():
    ds = sorted(days)
    for i, d in enumerate(ds):
        bars = days[d]
        if len(bars) < 40 or i < 5: continue
        w = bars[:9]
        prev = days[ds[i - 1]][-1][3]
        if prev <= 0: continue
        gap = (w[0][0] / prev - 1) * 100
        if not (-2.0 <= gap <= 1.5): continue
        hi = lo = None; mids = []; below_last = -1
        for k, b in enumerate(w):
            hi = b[1] if hi is None else max(hi, b[1])
            lo = b[2] if lo is None else min(lo, b[2])
            mids.append((hi + lo) / 2)
            if b[3] < prev: below_last = k
        ent = None
        for k in range(9):
            if w[k][3] >= prev and mids[k] >= prev and below_last <= k:
                ent = k; break
        if ent is None: continue
        px = w[ent][3]
        if px <= 0: continue
        n = ent + 1
        v_now = M([b[4] for b in w[:n]])
        hist = [M([b[4] for b in days[ds[j]][:n]]) for j in range(i - 5, i) if len(days[ds[j]]) >= n]
        vr = v_now / M(hist) if hist and M(hist) > 0 else None
        uw = [b[4] for b in w if b[3] < prev]
        shrink = M(uw) / w[0][4] if uw and w[0][4] > 0 else None
        rows.append({'date': d, 'pool': pool, 'ent': ent, 'gap': gap,
                     'vr': vr, 'shrink': shrink,
                     'ret': (bars[-1][3] / px - 1) * 100 - FEE})

print(f'主干 {len(rows)}\n')


def show(sub, tag):
    if len(sub) < 60: print(f'  {tag:26s} n={len(sub):5d} 样本少'); return
    ex = [r['ret'] - BASE[(r['date'], r['pool'])] for r in sub if (r['date'], r['pool']) in BASE]
    print(f'  {tag:26s} n={len(sub):5d} 超额 {M(ex):+.3f}% (t={tstat(ex):5.2f}) 绝对 {M([r["ret"] for r in sub]):+.3f}%')


print('===== A. 量比（入场前信息）=====')
for lo, hi in ((0, 0.8), (0.8, 1.2), (1.2, 2.0), (2.0, 3.0), (3.0, 99)):
    show([r for r in rows if r['vr'] is not None and lo <= r['vr'] < hi], f'量比{lo}~{hi}')

print('\n===== B. 回踩缩量比 =====')
for lo, hi in ((0, 0.6), (0.6, 1.0), (1.0, 2.0), (2.0, 99)):
    show([r for r in rows if r['shrink'] is not None and lo <= r['shrink'] < hi], f'缩量比{lo}~{hi}')

print('\n===== C. 量比 × 入场时刻 =====')
for k, nm in ((0, '9:35'), (1, '9:40'), (2, '9:45')):
    for lo, hi in ((0, 0.8), (0.8, 1.2), (1.2, 99)):
        show([r for r in rows if r['ent'] == k and r['vr'] is not None and lo <= r['vr'] < hi],
             f'{nm} 量比{lo}~{hi}')

print('\n===== D. 最终推荐口径对比 =====')
show(rows, '主干全部')
show([r for r in rows if r['ent'] == 0], '仅9:35当即达标')
show([r for r in rows if r['ent'] == 0 and r['vr'] is not None and r['vr'] < 1.2], '9:35 + 量比<1.2')
show([r for r in rows if r['ent'] == 0 and r['vr'] is not None and r['vr'] >= 1.2], '9:35 + 量比>=1.2')
show([r for r in rows if r['ent'] == 0 and r['pool'] == 'small'], '9:35 + 中小盘')
show([r for r in rows if r['ent'] == 0 and r['pool'] == 'small' and r['vr'] is not None and r['vr'] < 1.2],
     '9:35 + 中小盘 + 量比<1.2')
