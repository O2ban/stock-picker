#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v12：严格对齐用户口径 + 图表指标定义

指标（严格照 chart.js timelineFormulas）：
  中（降中线） = (当日累计最高 + 当日累计最低) / 2
  分时前高 HH  = REF(HHV(H, FROMOPEN), 5)  = 5 根之前的当日累计最高
  M20          = 20 根简单均线（收盘）

触发点（用户口径）：
  ① 从水下翻上水面：收盘价由 <昨收 变为 >=昨收，且「中」已在水上
  ② 过分时前高：收盘价 > HH（即突破5根前就固定下来的前高），且「中」已在水上
  ③ 上穿降中线：收盘价上穿「中」，且「中」本身在昨收之上

量能（用户口径：整体缩量即可，缩量上涨也算）：
  量能比 = 开盘至触发时段的均量 / 前5日同样根数的均量
  <1 为缩量，>1 为放量

收益三种口径：当日收盘 / 次日开盘 / 次日收盘，均扣费 0.26%
超额 = 命中组收益 - 同日同池「9:35买持到收盘」平均收益
"""
import os, glob, csv, math

FEE = 0.26
GAP_LO, GAP_HI = -2.0, 3.0
MAXT = 48          # 只看上午收市前（前24根）或全天，按需调
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

BASE = {}
for code, (pool, days) in DATA.items():
    for d, bars in days.items():
        if len(bars) < 40: continue
        BASE.setdefault((d, pool), []).append((bars[-1][3] / bars[0][3] - 1) * 100)
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

        # 逐根算 中 与 HH
        hi = lo = None
        mid, hh = [], []
        run = []
        for b in bars:
            hi = b[1] if hi is None else max(hi, b[1])
            lo = b[2] if lo is None else min(lo, b[2])
            run.append(hi)
            mid.append((hi + lo) / 2)
            hh.append(run[-6] if len(run) >= 6 else None)   # 5根之前

        # 前5日 每根序号上的成交量，用于同跨度量能比
        hist_bars = [days[ds[j]][:len(bars)] for j in range(i - 5, i)]

        trig = {}
        for k in range(1, min(len(bars), MAXT)):
            c, c0 = bars[k][3], bars[k - 1][3]
            ok_mid = mid[k] >= prev                      # 中在水上
            # ① 翻上水面
            if ok_mid and c0 < prev and c >= prev and 'surge' not in trig:
                trig['surge'] = k
            # ② 过分时前高
            if ok_mid and hh[k] is not None and c > hh[k] and 'break' not in trig:
                trig['break'] = k
            # ③ 上穿降中线
            if ok_mid and c >= mid[k] and c0 < mid[k - 1] and 'mid' not in trig:
                trig['mid'] = k

        for tag, k in trig.items():
            if k >= len(bars) - 1: continue
            px = bars[k][3]
            if px <= 0: continue
            n = k + 1
            hist = [M([b[4] for b in hb[:n]]) for hb in hist_bars if len(hb) >= n]
            vr = M([b[4] for b in bars[:n]]) / M(hist) if hist and M(hist) > 0 else None
            rows.append({'code': code, 'pool': pool, 'date': d, 'tag': tag, 't': k,
                         'gap': gap, 'chg': (px / prev - 1) * 100, 'vr': vr,
                         'dret': (bars[-1][3] / px - 1) * 100 - FEE,
                         'nopen': (days[ds[i + 1]][0][0] / px - 1) * 100 - FEE,
                         'nclose': (days[ds[i + 1]][-1][3] / px - 1) * 100 - FEE})

print(f'触发记录 {len(rows)}')


def show(sub, tag):
    if len(sub) < 60:
        print(f'    {tag:30s} n={len(sub):5d} 样本少'); return
    ex = [r['dret'] - BASE[(r['date'], r['pool'])] for r in sub if (r['date'], r['pool']) in BASE]
    print(f'    {tag:30s} n={len(sub):5d} 当日收 {M([r["dret"] for r in sub]):+.3f}% '
          f'次日开 {M([r["nopen"] for r in sub]):+.3f}% '
          f'次日收 {M([r["nclose"] for r in sub]):+.3f}% '
          f'| 超额 {M(ex):+.3f}% (t={tstat(ex):5.2f})')


NAMES = {'surge': '①翻上水面+中在水上', 'break': '②过分时前高+中在水上', 'mid': '③上穿降中线'}

for tag in ('surge', 'break', 'mid'):
    sub = [r for r in rows if r['tag'] == tag]
    print(f'\n===== {NAMES[tag]} =====')
    show(sub, '全部')
    print('  -- 按时间 --')
    for lo, hi, lb in ((1, 3, '9:40~9:45'), (3, 6, '9:50~10:05'), (6, 12, '10:10~10:50'),
                       (12, 24, '10:55~上午收'), (24, 48, '下午')):
        show([r for r in sub if lo <= r['t'] < hi], lb)
    print('  -- 按量能（<1缩量 >1放量）--')
    for lo, hi in ((0, 0.6), (0.6, 0.8), (0.8, 1.0), (1.0, 1.5), (1.5, 3.0), (3.0, 99)):
        show([r for r in sub if r['vr'] is not None and lo <= r['vr'] < hi], f'量能{lo}~{hi}')
    print('  -- 按触发时涨幅 --')
    for lo, hi in ((-9, 0), (0, 1), (1, 2), (2, 3), (3, 99)):
        show([r for r in sub if lo <= r['chg'] < hi], f'涨{lo}~{hi}%')

print('\n\n===== 关键对比：有/无「中在水上」这一条 =====')
print('（下方另外用不要求 中在水上 的版本，看在早盘时段差多少）')
