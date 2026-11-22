#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v7：修正量比的前视偏差（只用入场前已发生的成交量）+ 定稿口径
入场时刻 k（5 分钟 bar 序号，0=9:35收盘那根）→ 决策时只知 bar 0..k-1 的成交。
量比 = 开盘以来均量 / 前 5 日开盘以来同跨度均量。
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
            n_bar = ent + 1                     # 决策时已知的 bar 数
            v_now = sum(b[4] for b in win[:n_bar]) / n_bar
            hist = []
            for j in range(i - 5, i):
                hb = days[j][1][:n_bar]
                if len(hb) == n_bar:
                    hist.append(sum(b[4] for b in hb) / n_bar)
            vr = v_now / M(hist) if hist and M(hist) > 0 else None
            post = bars[ent + 1:]
            nxt = days[i + 1][1]
            out.append({
                'code': code, 'pool': pool, 'date': d, 'ent': ent, 'gap': gap,
                'px': px, 'chg': (px / prev - 1) * 100, 'vr': vr,
                'close': (bars[-1][3] / px - 1) * 100,
                'nopen': (nxt[0][0] / px - 1) * 100,
                'nclose': (nxt[-1][3] / px - 1) * 100,
                'mx': (max(b[1] for b in post) / px - 1) * 100 if post else 0.0,
                'mn': (min(b[2] for b in post) / px - 1) * 100 if post else 0.0,
            })
    return out


def show(rows, tag):
    if len(rows) < 30:
        print(f'{tag:34s} n={len(rows):5d}  样本少，不作结论')
        return None
    v = [r['close'] - FEE for r in rows]
    sd = math.sqrt(sum((x - M(v)) ** 2 for x in v) / max(len(v) - 1, 1))
    t = M(v) / (sd / math.sqrt(len(v))) if sd > 0 else 0
    print(f'{tag:34s} n={len(v):5d} 收盘 {M(v):+.3f}% (t={t:5.2f}) 胜{W(v):4.1f}% '
          f'次日开 {M([r["nopen"]-FEE for r in rows]):+.3f}% '
          f'| 曾涨1% {W([1 if r["mx"]>=1 else 0 for r in rows]):4.1f}%')
    return v


def main():
    files = sorted(glob.glob(POOL + '*.csv')) + sorted(glob.glob(BIG + '*.ndjson'))
    rows = scan(files)
    print(f'主干命中 {len(rows)} 次（无前视）\n')
    show(rows, '主干全部')

    print('\n===== 量比（只用入场前已发生成交） =====')
    rv = [r for r in rows if r['vr'] is not None]
    for lo, hi in ((0, 0.8), (0.8, 1.2), (1.2, 2.0), (2.0, 3.0), (3.0, 999)):
        show([r for r in rv if lo <= r['vr'] < hi], f'量比 {lo}~{hi}')

    print('\n===== 量比 × 入场时刻 =====')
    for k in (0, 1):
        for lo, hi in ((0, 1.2), (1.2, 2.0), (2.0, 999)):
            show([r for r in rv if r['ent'] == k and lo <= r['vr'] < hi],
                 f'9:{35+5*k:02d}入场 量比{lo}~{hi}')

    print('\n===== 入场涨幅 × 量比 =====')
    for lo, hi in ((0, 1), (1, 2), (2, 5), (5, 100)):
        for vlo, vhi in ((0, 1.2), (1.2, 2.0), (2.0, 999)):
            show([r for r in rv if lo <= r['chg'] < hi and vlo <= r['vr'] < vhi],
                 f'涨{lo}~{hi}% 量比{vlo}~{vhi}')

    print('\n===== 最终候选口径：量比>2 + 9:40前入场 =====')
    final = [r for r in rv if r['vr'] >= 2.0 and r['ent'] <= 1]
    show(final, '量比>2且9:40前')
    if final:
        byy = {}
        for r in final:
            byy.setdefault(r['date'][:4], []).append(r)
        print('  分年:')
        for y in sorted(byy):
            vv = [r['close'] - FEE for r in byy[y]]
            print(f'    {y} n={len(vv):4d} {M(vv):+.3f}% 胜率 {W(vv):.1f}%')
        print('  分池:')
        for p, nm in (('small', '中小盘20只'), ('big', '大盘股8只')):
            sub = [r for r in final if r['pool'] == p]
            if sub:
                vv = [r['close'] - FEE for r in sub]
                print(f'    {nm} n={len(vv)} {M(vv):+.3f}% 胜率 {W(vv):.1f}%')
        print('  出场规则:')
        for tp, sl, nm in ((1.0, 1.0, '1止盈1止损'), (1.5, 1.0, '1.5止盈1止损'),
                           (2.0, 1.0, '2止盈1止损'), (3.0, 1.5, '3止盈1.5止损')):
            res = []
            for r in final:
                hitp = r['mx'] >= tp
                hitl = r['mn'] <= -sl
                if hitp and hitl:
                    res.append(-sl)     # 保守先算止损
                elif hitp:
                    res.append(tp)
                elif hitl:
                    res.append(-sl)
                else:
                    res.append(r['close'])
            vv = [x - FEE for x in res]
            print(f'    {nm} 均值 {M(vv):+.3f}% 胜率 {W(vv):.1f}%')
        print('  最近 12 个自然日命中名单:')
        for d in sorted({r['date'] for r in final})[-12:]:
            for r in [x for x in final if x['date'] == d]:
                print(f"    {d} {r['code']:9s} 开{r['gap']:+5.2f}% 入9:{35+5*r['ent']:02d} "
                      f"入时{r['chg']:+5.2f}% 量比{r['vr']:4.2f} 当日最高{r['mx']:+5.2f}% "
                      f"收盘{r['close']:+5.2f}% 次日开{r['nopen']:+5.2f}%")


if __name__ == '__main__':
    main()
