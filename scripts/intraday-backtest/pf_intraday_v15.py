#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v15：时间对齐对照 —— 信号的超额只跟「同一时刻随便买」比"""
import os, glob, csv, math

FEE = 0.26
MAXT = 8  # k=1..7 -> 9:40 ~ 10:10（用户窗口 9:35~10:15）
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
    return days


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
    return days


def M(v): return sum(v) / len(v) if v else float('nan')
def W(v): return sum(1 for x in v if x > 0) / len(v) * 100 if v else float('nan')
def tstat(v):
    if len(v) < 5: return 0.0
    m = M(v); sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    return m / (sd / math.sqrt(len(v))) if sd > 0 else 0.0


DATA = {}
for fp in sorted(glob.glob(POOL + '*.csv')):
    dd = load_csv(fp)
    if dd: DATA[os.path.basename(fp)[:-4]] = ('small', dd)
for fp in sorted(glob.glob(BIG + '*.ndjson')):
    dd = load_ndjson(fp)
    if dd: DATA[os.path.basename(fp).split('.')[0]] = ('big', dd)
print(f'有效股票 {len(DATA)} 只：中小盘池 {sum(1 for v in DATA.values() if v[0]=="small")}，大盘 {sum(1 for v in DATA.values() if v[0]=="big")}\n')

# ---- 时间对齐对照：同日同池，同 k 时刻买入持到收盘，全票平均 ----
CTRL = {}
for code, (pool, days) in DATA.items():
    for d, bars in days.items():
        if len(bars) < 40: continue
        cl = bars[-1][3]
        for k in range(1, MAXT + 1):
            if k >= len(bars): break
            px = bars[k][3]
            if px <= 0: continue
            CTRL.setdefault((d, pool, k), []).append((cl / px - 1) * 100 - FEE)
CTRL = {k: M(v) for k, v in CTRL.items()}

sig = []
for code, (pool, days) in DATA.items():
    ds = sorted(days)
    for i, d in enumerate(ds):
        bars = days[d]
        if len(bars) < 40 or i < 6: continue
        prev = days[ds[i - 1]][-1][3]
        if prev <= 0: continue
        gap = (bars[0][0] / prev - 1) * 100
        if not (-2.0 <= gap <= 3.0): continue
        hi = lo = None
        mid, hh, run = [], [], []
        for b in bars:
            hi = b[1] if hi is None else max(hi, b[1])
            lo = b[2] if lo is None else min(lo, b[2])
            run.append(hi); mid.append((hi + lo) / 2)
            hh.append(run[-6] if len(run) >= 6 else None)
        hist = [days[ds[j]] for j in range(i - 5, i)]
        for k in range(1, min(MAXT + 1, len(bars))):
            ctl = CTRL.get((d, pool, k))
            if ctl is None: continue
            c, c0 = bars[k][3], bars[k - 1][3]
            if c <= 0: continue
            n = k + 1
            hv = [M([b[4] for b in hb[:n]]) for hb in hist if len(hb) >= n]
            vr = M([b[4] for b in bars[:n]]) / M(hv) if hv and M(hv) > 0 else None
            if vr is None: continue
            ret = (bars[-1][3] / c - 1) * 100 - FEE
            sig.append({'date': d, 'pool': pool, 'code': code, 'k': k, 'vr': vr,
                        'gap': gap, 'chg': (c / prev - 1) * 100,
                        'mid_up': mid[k] >= prev,
                        'surge': c0 < prev <= c,
                        'brk': hh[k] is not None and c > hh[k],
                        'up_mid': c > mid[k] and c0 <= mid[k - 1],
                        'ret': ret, 'ex': ret - ctl})


def first_of(pred):
    seen = {}
    for r in sig:
        if not pred(r): continue
        key = (r['code'], r['date'])
        if key not in seen or r['k'] < seen[key]['k']: seen[key] = r
    return list(seen.values())


def show(rows, tag):
    if not rows: print(f'  {tag:40s} 无样本'); return
    if len(rows) < 50: print(f'  {tag:40s} n={len(rows):5d} 样本少'); return
    e = [r['ex'] for r in rows]; r_ = [r['ret'] for r in rows]
    print(f'  {tag:40s} n={len(rows):5d} 净 {M(r_):+.3f}% 胜 {W(r_):4.1f}% | 超额 {M(e):+.3f}% (t={tstat(e):6.2f})')


print('===== 时间对齐超额（跟「同一分钟随便买同池股票」比）=====')
ks = [
    ('翻上水面（不限中在水上）', lambda r: r['surge']),
    ('翻上水面 + 中在水上', lambda r: r['surge'] and r['mid_up']),
    ('翻上水面 + 中在水上 + 缩量<0.8', lambda r: r['surge'] and r['mid_up'] and r['vr'] < 0.8),
    ('翻上水面 + 中在水上 + 缩量<1.0', lambda r: r['surge'] and r['mid_up'] and r['vr'] < 1.0),
    ('过分时前高', lambda r: r['brk']),
    ('过分时前高 + 中在水上', lambda r: r['brk'] and r['mid_up']),
    ('过分时前高 + 中在水上 + 缩量<0.8', lambda r: r['brk'] and r['mid_up'] and r['vr'] < 0.8),
    ('上穿降中线', lambda r: r['up_mid']),
    ('上穿降中线 + 缩量<0.8', lambda r: r['up_mid'] and r['vr'] < 0.8),
    ('翻上水面 或 过前高', lambda r: r['surge'] or r['brk']),
]
res = {}
for nm, fn in ks:
    rows = first_of(fn); res[nm] = rows; show(rows, nm)

print('\n===== 分池看（翻上水面 + 中在水上）=====')
for pool in ('small', 'big'):
    rows = first_of(lambda r: r['surge'] and r['mid_up'] and r['pool'] == pool)
    show(rows, f'  {pool}')

print('\n===== 分年（翻上水面 + 中在水上）=====')
rows = first_of(lambda r: r['surge'] and r['mid_up'])
byy = {}
for r in rows: byy.setdefault(r['date'][:4], []).append(r)
for y in sorted(byy):
    e = [r['ex'] for r in byy[y]]; r_ = [r['ret'] for r in byy[y]]
    print(f'  {y} n={len(e):4d} 净 {M(r_):+.3f}% 胜 {W(r_):4.1f}% 超额 {M(e):+.3f}% (t={tstat(e):5.2f})')

print('\n===== 按触发时刻（翻上水面 + 中在水上）=====')
rows = first_of(lambda r: r['surge'] and r['mid_up'])
byk = {}
for r in rows: byk.setdefault(r['k'], []).append(r)
for k in sorted(byk):
    e = [r['ex'] for r in byk[k]]; r_ = [r['ret'] for r in byk[k]]
    tm = f'09:{35+5*k:02d}' if 35 + 5 * k < 60 else f'10:{5*k-25:02d}'
    print(f'  {tm} n={len(e):4d} 净 {M(r_):+.3f}% 胜 {W(r_):4.1f}% 超额 {M(e):+.3f}%')

print('\n===== 按开盘幅度（翻上水面 + 中在水上）=====')
rows = first_of(lambda r: r['surge'] and r['mid_up'])
byg = {}
for r in rows:
    b = '<-1' if r['gap'] < -1 else ('-1~0' if r['gap'] < 0 else ('0~1' if r['gap'] < 1 else ('1~2' if r['gap'] < 2 else '2~3')))
    byg.setdefault(b, []).append(r)
for b in ('<-1', '-1~0', '0~1', '1~2', '2~3'):
    if b in byg:
        e = [r['ex'] for r in byg[b]]
        print(f'  {b:5s} n={len(e):4d} 净 {M([r["ret"] for r in byg[b]]):+.3f}% 超额 {M(e):+.3f}%')

print('\n===== 按量能（翻上水面 + 中在水上）=====')
rows = first_of(lambda r: r['surge'] and r['mid_up'])
byv = {}
for r in rows:
    b = '<0.6' if r['vr'] < 0.6 else ('0.6~0.8' if r['vr'] < 0.8 else ('0.8~1.0' if r['vr'] < 1.0 else ('1.0~1.5' if r['vr'] < 1.5 else '>=1.5')))
    byv.setdefault(b, []).append(r)
for b in ('<0.6', '0.6~0.8', '0.8~1.0', '1.0~1.5', '>=1.5'):
    if b in byv:
        e = [r['ex'] for r in byv[b]]
        print(f'  {b:7s} n={len(e):4d} 净 {M([r["ret"] for r in byv[b]]):+.3f}% 超额 {M(e):+.3f}%')
