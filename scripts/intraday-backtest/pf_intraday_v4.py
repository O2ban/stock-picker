#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v4：把「早盘在水上+中线水上」这条主干单独拎出来，做同分钟位置对照与逐年稳定性检验。
目的：分清到底是"条件有用"还是"买得早"这个时间因素在起作用。
"""
import os, glob, csv, math

FEE = 0.26
GAP_LO, GAP_HI = -2.0, 1.5
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
        days.setdefault(d, [])
        if not days[d]:
            order.append(d)
        days[d].append(v)
    return [(d, days[d]) for d in order]


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
        days.setdefault(d, [])
        if not days[d]:
            order.append(d)
        days[d].append(v)
    return [(d, days[d]) for d in order]


def M(v): return sum(v) / len(v) if v else float('nan')
def W(v): return sum(1 for x in v if x > 0) / len(v) * 100 if v else float('nan')


def run(files, tag):
    """对每天都算出「窗口内最早满足 水上+中线上水+10点前回水上 的槽位」，并记录每槽位基线。"""
    picks = []
    base_by_slot = {k: [] for k in range(9)}
    ndays = 0
    for fp in files:
        days = load_csv(fp) if fp.endswith('.csv') else load_ndjson(fp)
        code = os.path.basename(fp).split('.')[0]
        pool = 'small' if os.path.exists(POOL + code + '.csv') else 'big'
        for i in range(1, len(days) - 1):
            d, bars = days[i]
            if len(bars) < 40:
                continue
            prev = days[i - 1][1][-1][3]
            if prev <= 0:
                continue
            win = bars[:9]
            gap = (win[0][0] / prev - 1) * 100
            if not (GAP_LO <= gap <= GAP_HI):
                continue
            ndays += 1
            hi = lo = None
            mids = []
            for b in win:
                hi = b[1] if hi is None else max(hi, b[1])
                lo = b[2] if lo is None else min(lo, b[2])
                mids.append((hi + lo) / 2)
            last_below = -1
            for k in range(9):
                if win[k][3] < prev:
                    last_below = k
            for k in range(9):
                px = win[k][3]
                if px > 0:
                    base_by_slot[k].append((bars[-1][3] / px - 1) * 100)
            ent = None
            for k in range(9):
                if win[k][3] < prev or mids[k] < prev:
                    continue
                if last_below > k or last_below > 2:
                    break
                ent = k
                break
            if ent is None:
                continue
            px = win[ent][3]
            post = bars[ent + 1:]
            nxt = days[i + 1][1]
            picks.append({
                'code': code, 'pool': pool, 'date': d, 'slot': ent, 'gap': gap,
                'close': (bars[-1][3] / px - 1) * 100,
                'nopen': (nxt[0][0] / px - 1) * 100,
                'nclose': (nxt[-1][3] / px - 1) * 100,
                'mx': (max(b[1] for b in post) / px - 1) * 100 if post else 0.0,
                'mn': (min(b[2] for b in post) / px - 1) * 100 if post else 0.0,
            })

    print(f'\n===== {tag} =====')
    print(f'符合开盘幅度的交易日 {ndays}，早盘强势命中 {len(picks)} '
          f'（{len(picks)/max(ndays,1)*100:.1f}%）')
    if not picks:
        return
    # 同槽位对照
    print('入场时点分布 & 同槽位对照:')
    for k in range(9):
        a = [p['close'] - FEE for p in picks if p['slot'] == k]
        b = [x - FEE for x in base_by_slot[k]]
        if not a:
            continue
        print(f'  9:{35+5*k:02d}  命中 {len(a):5d} 次 收盘卖 {M(a):+.3f}% (胜{W(a):4.1f}%)'
              f'  | 全部样本同期 {M(b):+.3f}% (胜{W(b):4.1f}%)  差 {M(a)-M(b):+.3f}%')
    v = [p['close'] - FEE for p in picks]
    sd = math.sqrt(sum((x - M(v)) ** 2 for x in v) / max(len(v) - 1, 1))
    print(f'\n整体: 收盘卖 {M(v):+.3f}% ±{1.96*sd/math.sqrt(len(v)):.3f} 胜率 {W(v):.1f}%')
    print(f'      次日开 {M([p["nopen"]-FEE for p in picks]):+.3f}% (胜{W([p["nopen"]-FEE for p in picks]):.1f}%)')
    print(f'      次日收 {M([p["nclose"]-FEE for p in picks]):+.3f}% (胜{W([p["nclose"]-FEE for p in picks]):.1f}%)')
    ma = [p['mx'] for p in picks]
    print(f'      买入后当日最大浮盈 均值 {M(ma):+.2f}% 中位 {sorted(ma)[len(ma)//2]:+.2f}%;'
          f' 最大浮亏 均值 {M([p["mn"] for p in picks]):+.2f}%')
    for thr in (0.5, 1.0, 1.5, 2.0):
        print(f'      当日曾涨过 +{thr}%: {sum(1 for x in ma if x>=thr)/len(ma)*100:.1f}%')
    print('\n按年份:')
    byy = {}
    for p in picks:
        byy.setdefault(p['date'][:4], []).append(p)
    for y in sorted(byy):
        vv = [p['close'] - FEE for p in byy[y]]
        print(f'  {y} n={len(vv):4d} {M(vv):+.3f}% 胜率 {W(vv):.1f}%')
    print('\n按池:')
    for pool, name in (('small', '中小盘池20只'), ('big', '大盘股8只')):
        sub = [p for p in picks if p['pool'] == pool]
        if sub:
            vv = [p['close'] - FEE for p in sub]
            print(f'  {name} n={len(vv)} {M(vv):+.3f}% 胜率 {W(vv):.1f}%')
    print('\n按开盘涨跌幅分组:')
    for lo, hi, name in ((-2.0, -0.5, '低开1个点以上'), (-0.5, 0.2, '平开'), (0.2, 1.5, '高开0.2~1.5%')):
        sub = [p for p in picks if lo <= p['gap'] < hi]
        if sub:
            vv = [p['close'] - FEE for p in sub]
            print(f'  {name:14s} n={len(vv):4d} {M(vv):+.3f}% 胜率 {W(vv):.1f}%')


if __name__ == '__main__':
    files = sorted(glob.glob(POOL + '*.csv')) + sorted(glob.glob(BIG + '*.ndjson'))
    run(files, '全部 28 只（5 分钟数据 2020-01 ~ 2026-11）')
