#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v8：真伪检验 —— 命中组 vs 同日同池「随便买」基准（同样的 9:35 买、持到收盘口径）。
若超额≈0，说明这套条件只是沾了这 28 只股票整体上涨的光，本身没有选股价值。
同时按「交易日」聚合，避免同一天多只股票重复计数把显著性吹高。
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
def W(v): return sum(1 for x in v if x > 0) / len(v) * 100 if v else float('nan')


def tstat(v):
    if len(v) < 5: return 0.0
    m = M(v)
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    return m / (sd / math.sqrt(len(v))) if sd > 0 else 0.0


def main():
    data = {}   # code -> {'pool':.., 'days':{date:[bars]}}
    for fp in sorted(glob.glob(POOL + '*.csv')):
        code = os.path.basename(fp)[:-4]
        data[code] = {'pool': 'small', 'days': load_csv(fp)}
    for fp in sorted(glob.glob(BIG + '*.ndjson')):
        code = os.path.basename(fp).split('.')[0]
        data[code] = {'pool': 'big', 'days': load_ndjson(fp)}
    print(f'载入 {len(data)} 只\n')

    # 逐股逐日：先算「随便买」基准收益，再判断是否命中
    base = {}    # (date,pool) -> [ret]
    hits = {}    # date -> [dict]
    for code, info in data.items():
        days = sorted(info['days'])
        pool = info['pool']
        for i, d in enumerate(days):
            bars = info['days'][d]
            if len(bars) < 40:
                continue
            px0 = bars[0][3]
            prev = info['days'][days[i - 1]][-1][3] if i > 0 else 0
            if px0 <= 0 or prev <= 0:
                continue
            r_all = (bars[-1][3] / px0 - 1) * 100 - FEE
            base.setdefault((d, pool), []).append(r_all)

            win = bars[:9]
            gap = (px0 / prev - 1) * 100
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
            hits.setdefault(d, []).append({
                'code': code, 'pool': pool, 'ent': ent, 'gap': gap,
                'ret': (bars[-1][3] / px - 1) * 100 - FEE,
            })

    # 按交易日聚合：命中组均值 与 当日同池基准均值 之差
    daily = []
    for d in sorted(hits):
        hs = hits[d]
        pools = {h['pool'] for h in hs}
        bens = []
        for p in pools:
            if (d, p) in base:
                bens.append(M(base[(d, p)]))
        if not bens:
            continue
        b = M(bens)
        r = M([h['ret'] for h in hs])
        daily.append({'date': d, 'n': len(hs), 'hit': r, 'base': b, 'ex': r - b})

    hit_v = [x['hit'] for x in daily]
    base_v = [x['base'] for x in daily]
    ex_v = [x['ex'] for x in daily]
    print(f'===== 按交易日聚合（共 {len(daily)} 个交易日有命中）=====')
    print(f'命中组   均值 {M(hit_v):+.3f}%  中位 {sorted(hit_v)[len(hit_v)//2]:+.3f}%  t={tstat(hit_v):5.2f}  胜{W(hit_v):.1f}%')
    print(f'同日随便买 均值 {M(base_v):+.3f}%  中位 {sorted(base_v)[len(base_v)//2]:+.3f}%  t={tstat(base_v):5.2f}  胜{W(base_v):.1f}%')
    print(f'超额（命中-基准） 均值 {M(ex_v):+.3f}%  t={tstat(ex_v):5.2f}  超额>0 占比 {W(ex_v):.1f}%')

    print('\n===== 超额分年 =====')
    byy = {}
    for x in daily:
        byy.setdefault(x['date'][:4], []).append(x)
    for y in sorted(byy):
        v = [x['ex'] for x in byy[y]]
        print(f'  {y}  天数{len(v):4d}  命中 {M([x["hit"] for x in byy[y]]):+.3f}%  '
              f'基准 {M([x["base"] for x in byy[y]]):+.3f}%  超额 {M(v):+.3f}% (t={tstat(v):5.2f})')

    print('\n===== 超额：按命中数分组（当天命中越多 = 越像普涨）=====')
    for lo, hi in ((1, 1), (2, 3), (4, 40)):
        v = [x['ex'] for x in daily if lo <= x['n'] <= hi]
        if len(v) >= 20:
            print(f'  当日命中 {lo}~{hi} 只  n={len(v):4d}  超额 {M(v):+.3f}%  (t={tstat(v):5.2f})')

    print('\n===== 超额：9:35 vs 更晚入场 =====')
    d35 = []
    dlate = []
    for d in sorted(hits):
        hs = hits[d]
        pools = {h['pool'] for h in hs}
        bens = [M(base[(d, p)]) for p in pools if (d, p) in base]
        if not bens:
            continue
        b = M(bens)
        a = [h['ret'] for h in hs if h['ent'] == 0]
        c = [h['ret'] for h in hs if h['ent'] >= 1]
        if a: d35.append(M(a) - b)
        if c: dlate.append(M(c) - b)
    print(f'  9:35 入场 n天={len(d35):4d} 超额 {M(d35):+.3f}% (t={tstat(d35):5.2f})')
    print(f'  9:40后入场 n天={len(dlate):4d} 超额 {M(dlate):+.3f}% (t={tstat(dlate):5.2f})')

    print('\n===== 门槛对照：把「10点前回水上+中线上水」去掉，只留开盘幅度 =====')
    print('  （说明这套条件的核心贡献是否来自「早盘回到水上」这件事本身）')
    # 简单版：同池同日、9:35 买、持到收盘已算在 base 里；此处看 base 全样本分年
    allb = []
    for (d, p), v in sorted(base.items()):
        allb.append((d, M(v)))
    byy2 = {}
    for d, r in allb:
        byy2.setdefault(d[:4], []).append(r)
    for y in sorted(byy2):
        v = byy2[y]
        print(f'  {y} 全部随便买 均值 {M(v):+.3f}%  胜{W(v):.1f}%')


if __name__ == '__main__':
    main()
