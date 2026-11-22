#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v9：在「超额」口径下逐条复核用户原始条件（剔除同日同池大盘涨跌的影响）。
超额 = 命中组持到收盘收益 - 同日同池全部股票同样9:35买持到收盘的平均收益。
"""
import os, glob, csv, math

FEE = 0.26
POOL = '/home/ubuntu/stock-picker/data/min5_pool/'
BIG = '/home/ubuntu/stock-picker/data/min5/'


def load_csv(path):
    days, order = {}, []
    for row in csv.reader(open(path, encoding='utf-8', errors='ignore')):
        if len(row) < 8:
            continue
        d = row[0].strip()
        try:
            v = (float(row[2]), float(row[3]), float(row[4]), float(row[5]), float(row[6]))
        except ValueError:
            continue
        if d not in days:
            days[d] = []
            order.append(d)
        days[d].append(v)
    return {d: days[d] for d in order}


def load_ndjson(path):
    days, order = {}, []
    for line in open(path, encoding='utf-8', errors='ignore'):
        p = line.strip().split(',')
        if len(p) < 7:
            continue
        d = p[0][:8]
        try:
            v = (float(p[1]), float(p[2]), float(p[3]), float(p[4]), float(p[5]))
        except ValueError:
            continue
        if d not in days:
            days[d] = []
            order.append(d)
        days[d].append(v)
    return {d: days[d] for d in order}


def M(v): return sum(v) / len(v) if v else float('nan')


def tstat(v):
    if len(v) < 5: return 0.0
    m = M(v)
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    return m / (sd / math.sqrt(len(v))) if sd > 0 else 0.0


DATA = {}
for fp in sorted(glob.glob(POOL + '*.csv')):
    DATA[os.path.basename(fp)[:-4]] = ('small', load_csv(fp))
for fp in sorted(glob.glob(BIG + '*.ndjson')):
    DATA[os.path.basename(fp).split('.')[0]] = ('big', load_ndjson(fp))

# 预建 同日同池基准（9:35买持到收盘）
BASE = {}
for code, (pool, days) in DATA.items():
    ds = sorted(days)
    for i, d in enumerate(ds):
        bars = days[d]
        if len(bars) < 40: continue
        BASE.setdefault((d, pool), []).append((bars[-1][3] / bars[0][3] - 1) * 100 - FEE)
BASE = {k: M(v) for k, v in BASE.items()}


def collect(gap_lo, gap_hi, need_line=True):
    """返回命中记录列表。need_line=True 时要求 10 点前回水上且中线上水。"""
    out = []
    for code, (pool, days) in DATA.items():
        ds = sorted(days)
        for i, d in enumerate(ds):
            bars = days[d]
            if len(bars) < 40: continue
            w = bars[:9]
            prev = days[ds[i - 1]][-1][3] if i > 0 else 0
            if prev <= 0: continue
            gap = (w[0][0] / prev - 1) * 100
            if not (gap_lo <= gap <= gap_hi): continue
            hi = lo = None; mids = []; brk = False; below_last = -1
            for k, b in enumerate(w):
                hi = b[1] if hi is None else max(hi, b[1])
                lo = b[2] if lo is None else min(lo, b[2])
                mids.append((hi + lo) / 2)
                if b[2] < prev: brk = True
                if b[3] < prev: below_last = k
            ent = None
            for k in range(9):
                ok = w[k][3] >= prev and mids[k] >= prev
                if need_line:
                    ok = ok and below_last <= k
                if ok:
                    ent = k; break
            if ent is None: continue
            px = w[ent][3]
            if px <= 0: continue
            # 回踩时是否缩量：水下那几根的量 相对 第一根的量
            uw = [b[4] for k, b in enumerate(w) if b[3] < prev]
            shrink = (M(uw) / w[0][4]) if uw and w[0][4] > 0 else None
            out.append({'code': code, 'pool': pool, 'date': d, 'ent': ent, 'gap': gap,
                        'chg': (px / prev - 1) * 100, 'brk': brk, 'shrink': shrink,
                        'ret': (bars[-1][3] / px - 1) * 100 - FEE,
                        'nopen': (days[ds[i + 1]][0][0] / px - 1) * 100 - FEE if i + 1 < len(ds) else None})
    return out


def show(rows, tag, base=True):
    if len(rows) < 60:
        print(f'  {tag:30s} n={len(rows):5d}  样本少')
        return
    if base:
        ex = []
        for r in rows:
            b = BASE.get((r['date'], r['pool']))
            if b is not None: ex.append(r['ret'] - b)
        print(f'  {tag:30s} n={len(rows):5d}  超额 {M(ex):+.3f}% (t={tstat(ex):5.2f})  '
              f'绝对 {M([r["ret"] for r in rows]):+.3f}%')
    else:
        print(f'  {tag:30s} n={len(rows):5d}  绝对 {M([r["ret"] for r in rows]):+.3f}%')


H = collect(-2.0, 1.5, need_line=True)
print(f'主干命中 {len(H)} 次\n')

print('===== 1. 是否砸到水下（第一根/盘中有没有跌破昨收）=====')
show([r for r in H if r['brk']], '盘中跌破过昨收')
show([r for r in H if not r['brk']], '全天未跌破昨收')
show([r for r in H if r['ent'] == 0], '9:35当即就达标')
print('  → 注意：能「9:35当即达标」本身就意味着没在水下磨')

print('\n===== 2. 下跌时是否缩量（水下那几根均量/第一根量）=====')
for lo, hi, nm in ((0, 0.6, '明显缩量<0.6'), (0.6, 1.0, '略缩量0.6~1.0'),
                   (1.0, 2.0, '放量1.0~2.0'), (2.0, 9e9, '大幅放量>2.0')):
    show([r for r in H if r['shrink'] is not None and lo <= r['shrink'] < hi], nm)

print('\n===== 3. 入场时刻 =====')
for k in range(0, 9):
    show([r for r in H if r['ent'] == k], f'9:{35+5*k:02d} 入场')

print('\n===== 4. 入场时涨幅 =====')
for lo, hi in ((-9, 0), (0, 1), (1, 2), (2, 3), (3, 5), (5, 99)):
    show([r for r in H if lo <= r['chg'] < hi], f'入场涨{lo}~{hi}%')

print('\n===== 5. 开盘幅度 =====')
for lo, hi, nm in ((-2.0, -1.0, '低开1~2%'), (-1.0, -0.2, '低开0.2~1%'),
                   (-0.2, 0.2, '平开'), (0.2, 0.8, '高开0.2~0.8%'), (0.8, 1.5, '高开0.8~1.5%')):
    show([r for r in H if lo <= r['gap'] < hi], nm)

print('\n===== 6. 分池 =====')
show([r for r in H if r['pool'] == 'small'], '中小盘20只')
show([r for r in H if r['pool'] == 'big'], '大盘股8只')

print('\n===== 7. 放宽开盘幅度限制（若放宽到 -3~+3 还能不能打）=====')
for lo, hi, nm in ((-3.0, -2.0, '低开2~3%'), (1.5, 2.0, '高开1.5~2%'), (2.0, 3.0, '高开2~3%')):
    sub = collect(lo, hi, need_line=True)
    show(sub, nm)

print('\n===== 8. 对比：不要「回水上+中线」条件，只要开盘合规 =====" =====')
H2 = collect(-2.0, 1.5, need_line=False)
print(f'  放宽后 n={len(H2)}')
show(H2, '只要开盘合规就9:35买')

print('\n===== 9. 出场：持到收盘 vs 次日开盘 =====')
sub = [r for r in H if r['nopen'] is not None]
ex_c, ex_n = [], []
for r in sub:
    b = BASE.get((r['date'], r['pool']))
    if b is None: continue
    ex_c.append(r['ret'] - b)
    ex_n.append(r['nopen'] - b)
print(f'  持到收盘超额 {M(ex_c):+.3f}% (t={tstat(ex_c):5.2f})')
print(f'  次日开盘卖超额 {M(ex_n):+.3f}% (t={tstat(ex_n):5.2f})')
