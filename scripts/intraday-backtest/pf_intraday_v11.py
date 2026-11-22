#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v11：按用户修正后的口径重测
  A) 缩量 = 整体量能缩（早盘量 vs 前5日同期），不要求下跌时缩量
  B) 触发点不固定时间：①从水下翻上水面 ②突破分时前高 ③上穿降中线
  C) 收益明确三种卖法：当日收盘 / 次日开盘 / 次日收盘
  D) 触发时间不设限，全天统计，看时间分布

分时指标（与 chart.js 一致）：
  降中线 中 = (当日累计最高 + 当日累计最低) / 2
  分时前高 HH = 5 根之前的当日累计最高
"""
import os, glob, csv, math

FEE = 0.26
GAP_LO, GAP_HI = -2.0, 3.0     # 按上次结论已放宽到 3
POOL = '/home/ubuntu/stock-picker/data/min5_pool/'
BIG = '/home/ubuntu/stock-picker/data/min5/'
NDAY = 48                       # 一天 48 根 5 分钟


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

# 同日同池基准：9:35 开盘那根收盘买、持到当天收盘
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
        if len(bars) < 40 or i < 6 or i + 1 >= len(ds): continue
        prev = days[ds[i - 1]][-1][3]
        if prev <= 0: continue
        gap = (bars[0][0] / prev - 1) * 100
        if not (GAP_LO <= gap <= GAP_HI): continue

        # 逐根滚动：累计最高/最低 → 降中线；前高 = 5 根之前的累计最高
        run_hi = run_lo = None
        mid = []
        for b in bars:
            run_hi = b[1] if run_hi is None else max(run_hi, b[1])
            run_lo = b[2] if run_lo is None else min(run_lo, b[2])
            mid.append((run_hi + run_lo) / 2)

        # 前5日同期均量（按同一根序号）
        hist_v = []
        for j in range(i - 5, i):
            hb = days[ds[j]]
            if len(hb) >= 6:
                hist_v.append(M([b[4] for b in hb[:6]]))   # 开盘前6根均量作参照
        hist_v6 = M(hist_v) if hist_v else 0.0

        t_surge = t_break = t_mid = None   # 三种触发各自首次时刻
        below = bars[0][3] < prev          # 当前是否在水下
        run_hi_before = bars[0][1]
        for k in range(len(bars)):
            b = bars[k]
            # ① 从水下翻上水面
            if t_surge is None:
                if k == 0:
                    if b[3] >= prev and b[2] >= prev:   # 全程水上
                        t_surge = 0
                else:
                    if b[3] >= prev and (bars[k - 1][3] < prev or b[2] < prev):
                        t_surge = k
            # ② 突破分时前高（创当日新高）
            if t_break is None and k > 0:
                if b[1] > run_hi_before and b[3] >= run_hi_before:
                    t_break = k
            # ③ 上穿降中线
            if t_mid is None and k > 0:
                if b[3] >= mid[k] and bars[k - 1][3] < mid[k - 1]:
                    t_mid = k
            run_hi_before = max(run_hi_before, b[1])
            if b[3] < prev: below = True
            elif b[3] >= prev: below = False

        def pack(t, tag):
            if t is None or t >= len(bars) - 1: return None
            px = bars[t][3]
            if px <= 0: return None
            n = t + 1
            v_now = M([b[4] for b in bars[:n]])
            vr = v_now / hist_v6 * (6 / n) if hist_v6 > 0 else None   # 归一化到同跨度
            return {'code': code, 'pool': pool, 'date': d, 'tag': tag, 't': t,
                    'gap': gap, 'chg': (px / prev - 1) * 100, 'vr': vr,
                    'dret': (bars[-1][3] / px - 1) * 100,
                    'nopen': (days[ds[i + 1]][0][0] / px - 1) * 100,
                    'nclose': (days[ds[i + 1]][-1][3] / px - 1) * 100}

        for t, tag in ((t_surge, 'surge'), (t_break, 'break'), (t_mid, 'mid')):
            r = pack(t, tag)
            if r: rows.append(r)

print(f'总触发记录 {len(rows)}\n')


def show(sub, tag):
    if len(sub) < 60:
        print(f'  {tag:32s} n={len(sub):5d} 样本少'); return
    ex = [r['dret'] - FEE - BASE[(r['date'], r['pool'])] for r in sub if (r['date'], r['pool']) in BASE]
    d = M([r['dret'] - FEE for r in sub])
    n1 = M([r['nopen'] - FEE for r in sub])
    n2 = M([r['nclose'] - FEE for r in sub])
    print(f'  {tag:32s} n={len(sub):5d} 当日收盘 {d:+.3f}% | 次日开 {n1:+.3f}% | 次日收 {n2:+.3f}% | 超额 {M(ex):+.3f}%')


for tag, nm in (('surge', '①水下翻上水面'), ('break', '②突破分时前高'), ('mid', '③上穿降中线')):
    print(f'===== {nm} =====')
    sub = [r for r in rows if r['tag'] == tag]
    show(sub, '全部')
    print('  --- 按触发时刻（每根5分钟）---')
    for lo, hi, lb in ((0, 1, '9:35'), (1, 2, '9:40'), (2, 3, '9:45'), (3, 6, '9:50~10:05'),
                       (6, 12, '10:10~10:50'), (12, 24, '10:55~11:55/13:05'),
                       (24, 48, '下午')):
        show([r for r in sub if lo <= r['t'] < hi], lb)
    print('  --- 按整体量能（早盘相对前5日同期）---')
    for lo, hi in ((0, 0.5), (0.5, 0.8), (0.8, 1.0), (1.0, 1.3), (1.3, 99)):
        show([r for r in sub if r['vr'] is not None and lo <= r['vr'] < hi], f'量能 {lo}~{hi}')
    print('  --- 按触发时涨幅 ---')
    for lo, hi in ((-9, 0), (0, 1), (1, 2), (2, 3), (3, 99)):
        show([r for r in sub if lo <= r['chg'] < hi], f'触发时涨{lo}~{hi}%')
    print()

print('===== 组合：缩量 + 触发点 =====')
for tag, nm in (('surge', '翻上水面'), ('break', '突破前高'), ('mid', '上穿中线')):
    for lo, hi in ((0, 0.8), (0.8, 99)):
        show([r for r in rows if r['tag'] == tag and r['vr'] is not None and lo <= r['vr'] < hi],
             f'{nm} 量能{lo}~{hi}')
