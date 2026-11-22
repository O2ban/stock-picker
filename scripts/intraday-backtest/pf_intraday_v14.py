#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v14：数据自检 + 用户组合口径的最后一轮测试"""
import os, glob, csv, math

FEE = 0.26
MAXT = 12
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
def W(v): return sum(1 for x in v if x > 0) / len(v) * 100 if v else float('nan')
def tstat(v):
    if len(v) < 5: return 0.0
    m = M(v); sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    return m / (sd / math.sqrt(len(v))) if sd > 0 else 0.0


# ---------- 数据自检 ----------
print('===== 数据自检 =====')
d0 = load_csv(POOL + 'sh600621.csv')
ks = sorted(d0)
print(f'sh600621 CSV：{ks[0]} ~ {ks[-1]}，共 {len(ks)} 个交易日')
for d in ks[-2:]:
    print(f'  {d} 共{len(d0[d])}根  首根收盘 {d0[d][0][3]:.2f}  末根收盘 {d0[d][-1][3]:.2f}')
print('  前3根: ' + ' | '.join(f'O{b[0]:.2f} H{b[1]:.2f} L{b[2]:.2f} C{b[3]:.2f} V{b[4]:.0f}' for b in d0[ks[-1]][:3]))
print()

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

out = []
for code, (pool, days) in DATA.items():
    ds = sorted(days)
    for i, d in enumerate(ds):
        bars = days[d]
        if len(bars) < 40 or i < 6 or i + 1 >= len(ds): continue
        prev = days[ds[i - 1]][-1][3]
        if prev <= 0: continue
        gap = (bars[0][0] / prev - 1) * 100
        if not (-2.0 <= gap <= 3.0): continue

        hi = lo = None
        mid, hh, run = [], [], []
        for b in bars:
            hi = b[1] if hi is None else max(hi, b[1])
            lo = b[2] if lo is None else min(lo, b[2])
            run.append(hi)
            mid.append((hi + lo) / 2)
            hh.append(run[-6] if len(run) >= 6 else None)
        hist_bars = [days[ds[j]] for j in range(i - 5, i)]
        w = bars[:MAXT]

        # 只在触发前用过已发生数据
        for k in range(1, len(w)):
            c, c0 = w[k][3], w[k - 1][3]
            if not (mid[k] >= prev): continue        # 中在水上
            behind = any(w[j][3] < prev for j in range(k))   # 之前砸过水下（震荡验证）
            n = k + 1
            hv = [M([b[4] for b in hb[:n]]) for hb in hist_bars if len(hb) >= n]
            vr = M([b[4] for b in bars[:n]]) / M(hv) if hv and M(hv) > 0 else None
            if vr is None: continue
            px = bars[k][3]
            if px <= 0: continue
            surge = (c0 < prev <= c)
            brk = (hh[k] is not None and c > hh[k])
            chg = (px / prev - 1) * 100
            out.append({'date': d, 'pool': pool, 'code': code, 't': k, 'vr': vr,
                        'behind': behind, 'surge': surge, 'brk': brk, 'chg': chg,
                        'up_mid': c > mid[k] and c0 <= mid[k - 1],
                        'ret': (bars[-1][3] / px - 1) * 100 - FEE,
                        'nopen': (days[ds[i + 1]][0][0] / px - 1) * 100 - FEE,
                        'ex': (bars[-1][3] / px - 1) * 100 - FEE - BASE[(d, pool)]})

# 每天每票只取第一次满足各组合的时刻
def first_of(pred):
    seen = {}
    for r in out:
        if not pred(r): continue
        key = (r['code'], r['date'])
        if key not in seen or r['t'] < seen[key]['t']:
            seen[key] = r
    return list(seen.values())


def show(rows, tag):
    if len(rows) < 50:
        print(f'  {tag:44s} n={len(rows):5d} 样本少'); return
    print(f'  {tag:44s} n={len(rows):5d} 当日收 {M([r["ret"] for r in rows]):+.3f}% '
          f'胜 {W([r["ret"] for r in rows]):4.1f}% 次日开 {M([r["nopen"] for r in rows]):+.3f}% '
          f'| 超额 {M([r["ex"] for r in rows]):+.3f}% (t={tstat([r["ex"] for r in rows]):6.2f})')


print('===== 用户组合口径（每种口径每日每票取首次触发）=====')
cases = [
    ('翻上水面（中在水上）', lambda r: r['surge']),
    ('翻上水面 + 缩量<0.8', lambda r: r['surge'] and r['vr'] < 0.8),
    ('翻上水面 + 缩量<0.8 + 触发时涨幅<1%', lambda r: r['surge'] and r['vr'] < 0.8 and r['chg'] < 1),
    ('翻上水面 + 先砸过水下（震荡验证）', lambda r: r['surge'] and r['behind']),
    ('翻上水面 + 先砸过水下 + 缩量<0.8', lambda r: r['surge'] and r['behind'] and r['vr'] < 0.8),
    ('过分时前高', lambda r: r['brk']),
    ('过分时前高 + 缩量<0.8', lambda r: r['brk'] and r['vr'] < 0.8),
    ('过分时前高 + 缩量<0.8 + 涨幅<2%', lambda r: r['brk'] and r['vr'] < 0.8 and r['chg'] < 2),
    ('过分时前高 + 先砸过水下', lambda r: r['brk'] and r['behind']),
    ('上穿降中线', lambda r: r['up_mid']),
    ('上穿降中线 + 缩量<0.8', lambda r: r['up_mid'] and r['vr'] < 0.8),
    ('翻上水面 或 过前高（先到先买）', lambda r: r['surge'] or r['brk']),
    ('翻上水面+过前高 都要（先翻后破）', lambda r: r['brk'] and r['behind']),
]
for nm, fn in cases:
    show(first_of(fn), nm)

print('\n===== 分年最好的一档 =====')
best = first_of(lambda r: r['surge'] and r['behind'] and r['vr'] < 0.8)
byy = {}
for r in best: byy.setdefault(r['date'][:4], []).append(r)
for y in sorted(byy):
    v = [r['ret'] for r in byy[y]]
    print(f'  {y} n={len(v):4d} 净 {M(v):+.3f}% 胜率 {W(v):4.1f}%')
