#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v6：筛选力测试 + 实际名单
主干：开盘幅度[-2%,+1.5%] + 早盘水上 + 中线水上 + 10点前回水
问题：这套条件在 28 只股票上一年命中 12446 次，折算全市场每天几百只，无法直接选股。
      这里测几个可叠加的排序/收紧因子，看哪个能提升单位收益。
因子：
  F1 第一根 5 分钟 K 线整根在昨收之上（最低价 >= 昨收）
  F2 入场时涨幅大小
  F3 早盘量比（前 9 根均量 / 前 5 日同时段均量）
  F4 入场时刻
  F5 中线上水幅度
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


def scan(files):
    out = []
    for fp in files:
        days = load_csv(fp) if fp.endswith('.csv') else load_ndjson(fp)
        code = os.path.basename(fp).split('.')[0]
        pool = 'small' if os.path.exists(POOL + code + '.csv') else 'big'
        for i in range(5, len(days) - 1):
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
            ent = None
            for k in range(9):
                if win[k][3] >= prev and mids[k] >= prev and last_below <= k and last_below <= 2:
                    ent = k
                    break
            if ent is None:
                continue
            px = win[ent][3]
            if px <= 0:
                continue
            # 早盘量比：前 9 根总均量 / 前 5 日同一时段总均量
            v9 = sum(b[4] for b in win) / 9
            hist = []
            for j in range(i - 5, i):
                hb = days[j][1][:9]
                if len(hb) == 9:
                    hist.append(sum(b[4] for b in hb) / 9)
            vr = v9 / M(hist) if hist and M(hist) > 0 else None
            post = bars[ent + 1:]
            nxt = days[i + 1][1]
            out.append({
                'code': code, 'pool': pool, 'date': d, 'ent': ent, 'gap': gap,
                'px': px, 'prev': prev,
                'chg': (px / prev - 1) * 100,
                'mid_dev': (mids[ent] / prev - 1) * 100,
                'strong1': 1 if win[0][2] >= prev else 0,
                'vr': vr,
                'close': (bars[-1][3] / px - 1) * 100,
                'nopen': (nxt[0][0] / px - 1) * 100,
                'mx': (max(b[1] for b in post) / px - 1) * 100 if post else 0.0,
                'mn': (min(b[2] for b in post) / px - 1) * 100 if post else 0.0,
            })
    return out


def show(rows, tag):
    if len(rows) < 20:
        print(f'{tag:30s} n={len(rows):5d}  样本太少')
        return
    v = [r['close'] - FEE for r in rows]
    sd = math.sqrt(sum((x - M(v)) ** 2 for x in v) / max(len(v) - 1, 1))
    t = M(v) / (sd / math.sqrt(len(v))) if sd > 0 else 0
    print(f'{tag:30s} n={len(v):5d} 收盘卖 {M(v):+.3f}% (t={t:5.2f}) 胜{W(v):4.1f}% '
          f'| 曾涨1% {W([1 if r["mx"]>=1 else 0 for r in rows]):4.1f}% '
          f'| 曾涨2% {W([1 if r["mx"]>=2 else 0 for r in rows]):4.1f}%')


def main():
    files = sorted(glob.glob(POOL + '*.csv')) + sorted(glob.glob(BIG + '*.ndjson'))
    rows = scan(files)
    print(f'主干命中 {len(rows)} 次\n')
    print('===== F1 第一根 5 分钟整根在昨收之上 =====')
    show([r for r in rows if r['strong1']], '第一根没破水')
    show([r for r in rows if not r['strong1']], '第一根破过水')

    print('\n===== F2 入场时涨幅 =====')
    for lo, hi in ((-2, 0), (0, 1), (1, 2), (2, 3), (3, 5), (5, 100)):
        show([r for r in rows if lo <= r['chg'] < hi], f'入场涨幅 {lo}~{hi}%')

    print('\n===== F3 早盘量比 =====')
    rv = [r for r in rows if r['vr'] is not None]
    print(f'  有量比样本 {len(rv)}')
    for lo, hi in ((0, 0.8), (0.8, 1.2), (1.2, 2.0), (2.0, 3.0), (3.0, 999)):
        show([r for r in rv if lo <= r['vr'] < hi], f'量比 {lo}~{hi}')

    print('\n===== F4 入场时刻 =====')
    for k in (0, 1, 2, 3):
        show([r for r in rows if r['ent'] == k], f'9:{35+5*k:02d} 入场')
    show([r for r in rows if r['ent'] >= 4], '9:55 以后入场')

    print('\n===== F5 中线上水幅度 =====')
    for lo, hi in ((0, 0.3), (0.3, 0.8), (0.8, 1.5), (1.5, 99)):
        show([r for r in rows if lo <= r['mid_dev'] < hi], f'中线上水 {lo}~{hi}%')

    print('\n===== 组合收紧：第一根没破水 + 入场涨2~5% + 9:35/9:40 入场 =====')
    s = [r for r in rows if r['strong1'] and 2 <= r['chg'] < 5 and r['ent'] <= 1]
    show(s, '组合口径')
    s2 = [r for r in rows if r['strong1'] and r['chg'] >= 1 and r['ent'] <= 1]
    show(s2, '第一根没破水+涨1%+9:40前')

    print('\n===== 最近 15 个交易日实际名单（组合口径2） =====')
    dates = sorted({r['date'] for r in rows})[-15:]
    for d in dates:
        sub = [r for r in s2 if r['date'] == d]
        if not sub:
            continue
        for r in sub:
            print(f"  {d} {r['code']:9s} 开{r['gap']:+5.2f}% 入9:{35+5*r['ent']:02d} "
                  f"入时{r['chg']:+5.2f}% 量比{(r['vr'] or 0):4.2f} "
                  f"当日最高{r['mx']:+5.2f}% 收盘{r['close']:+5.2f}% 次日开{r['nopen']:+5.2f}%")


if __name__ == '__main__':
    main()
