#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v13：最终对账 —— 找出 v9/v10 与 v12 结论冲突的原因

核心嫌疑：v9/v10 里的判定用了「当天最后一次跌破昨收的位置」(below_last)，
这个值在买入那一刻是未知的（它包含了当天后续行情），属未来数据。

本脚本并排跑：
  A) 带前视版（复刻 v9/v10 逻辑）—— 预期虚高
  B) 严格无前视版（逐根推进，只用已发生信息）—— 真实水平
  C) 用户新口径：整体缩量 + 从水下翻上水面 / 过分时前高 / 上穿降中线

全部限定早盘 9:35~10:30（前12根）出手，持到收盘。
"""
import os, glob, csv, math

FEE = 0.26
GAP_LO, GAP_HI = -2.0, 3.0
MAXT = 12          # 前12根 = 9:35~10:30
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


DATA = {}
for fp in sorted(glob.glob(POOL + '*.csv')):
    DATA[os.path.basename(fp)[:-4]] = ('small', load_csv(fp))
for fp in sorted(glob.glob(BIG + '*.ndjson')):
    DATA[os.path.basename(fp).split('.')[0]] = ('big', load_ndjson(fp))

# 基准：同日同池 9:35那根收盘买入持到当日收盘（扣费后）
BASE = {}
for code, (pool, days) in DATA.items():
    for d, bars in days.items():
        if len(bars) < 40: continue
        BASE.setdefault((d, pool), []).append((bars[-1][3] / bars[0][3] - 1) * 100 - FEE)
BASE = {k: M(v) for k, v in BASE.items()}
print('基准（同日同池9:35买持到收盘，扣费后）全样本均值：%.3f%%' % M(list(BASE.values())))
print()

A, B, C, D = [], [], [], []

for code, (pool, days) in DATA.items():
    ds = sorted(days)
    for i, d in enumerate(ds):
        bars = days[d]
        if len(bars) < 40 or i < 6: continue
        prev = days[ds[i - 1]][-1][3]
        if prev <= 0: continue
        gap = (bars[0][0] / prev - 1) * 100
        if not (GAP_LO <= gap <= GAP_HI): continue

        w = bars[:MAXT]
        hi = lo = None
        mid, hh, run = [], [], []
        for b in bars:
            hi = b[1] if hi is None else max(hi, b[1])
            lo = b[2] if lo is None else min(lo, b[2])
            run.append(hi)
            mid.append((hi + lo) / 2)
            hh.append(run[-6] if len(run) >= 6 else None)

        hist_bars = [days[ds[j]] for j in range(i - 5, i)]

        def rec(k, tag):
            if k >= len(bars) - 1: return None
            px = bars[k][3]
            if px <= 0: return None
            n = k + 1
            hv = [M([b[4] for b in hb[:n]]) for hb in hist_bars if len(hb) >= n]
            vr = M([b[4] for b in bars[:n]]) / M(hv) if hv and M(hv) > 0 else None
            return {'date': d, 'pool': pool, 'code': code, 'tag': tag, 't': k, 'vr': vr,
                    'chg': (px / prev - 1) * 100,
                    'ret': (bars[-1][3] / px - 1) * 100 - FEE,
                    'ex': (bars[-1][3] / px - 1) * 100 - FEE - BASE[(d, pool)]}

        # ---- A) 带前视（复刻 v9/v10）：用当天最后破水位置 ----
        below_last = -1
        for k in range(len(w)):
            if w[k][3] < prev: below_last = k
        for k in range(len(w)):
            if w[k][3] >= prev and mid[k] >= prev and below_last <= k:
                r = rec(k, 'A')
                if r: A.append(r)
                break

        # ---- B) 无前视：逐根推进，第一次「收在水上且中在水上」就买 ----
        for k in range(len(w)):
            if w[k][3] >= prev and mid[k] >= prev:
                r = rec(k, 'B')
                if r: B.append(r)
                break

        # ---- C) 用户口径：整体缩量 + 三种触发点 ----
        seen = set()
        for k in range(1, len(w)):
            c, c0 = w[k][3], w[k - 1][3]
            ok_mid = mid[k] >= prev
            if not ok_mid: continue
            # ① 从水下翻上水面
            if 'surge' not in seen and c0 < prev <= c:
                r = rec(k, 'surge')
                if r: C.append(r); seen.add('surge')
            # ② 过分时前高
            if 'break' not in seen and hh[k] is not None and c > hh[k]:
                r = rec(k, 'break')
                if r: C.append(r); seen.add('break')
            # ③ 上穿降中线
            if 'mid' not in seen and c >= mid[k] and c0 < mid[k - 1]:
                r = rec(k, 'mid')
                if r: C.append(r); seen.add('mid')

        # ---- D) 对照：不做形态筛选，9:35 直接买 ----
        r = rec(0, 'D')
        if r: D.append(r)


def show(rows, tag):
    if len(rows) < 50:
        print(f'  {tag:34s} n={len(rows):5d} 样本少'); return
    print(f'  {tag:34s} n={len(rows):5d} 净收益 {M([r["ret"] for r in rows]):+.3f}%  '
          f'胜率 {W([r["ret"] for r in rows]):4.1f}%  '
          f'超额 {M([r["ex"] for r in rows]):+.3f}% (t={tstat([r["ex"] for r in rows]):6.2f})')


print('===== 对账：带前视 vs 无前视（同样早盘出手、持到收盘）=====')
show(A, 'A 带前视（v9/v10 的做法）')
show(B, 'B 无前视（只知当下）')
show(D, 'D 不筛形态，9:35直接买')

print('\n===== C 用户口径：三种触发点（无前视，中在水上）=====')
for t, nm in (('surge', '①翻上水面'), ('break', '②过分时前高'), ('mid', '③上穿降中线')):
    show([r for r in C if r['tag'] == t], nm)

print('\n===== C 各触发点 × 整体量能（<1缩量）=====')
for t, nm in (('surge', '翻上水面'), ('break', '过分时前高'), ('mid', '上穿中线')):
    for lo, hi, lb in ((0, 0.7, '缩量<0.7'), (0.7, 1.0, '0.7~1.0'), (1.0, 1.5, '1.0~1.5'), (1.5, 99, '放量>1.5')):
        show([r for r in C if r['tag'] == t and r['vr'] is not None and lo <= r['vr'] < hi], f'{nm} {lb}')

print('\n===== 分年（无前视 B 口径）=====')
byy = {}
for r in B: byy.setdefault(r['date'][:4], []).append(r)
for y in sorted(byy):
    v = [r['ret'] for r in byy[y]]
    e = [r['ex'] for r in byy[y]]
    print(f'  {y} n={len(v):5d} 净 {M(v):+.3f}% 胜率 {W(v):4.1f}% 超额 {M(e):+.3f}%')
