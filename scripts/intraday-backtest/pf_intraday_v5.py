#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5：买点设计对比 + 出场规则
在「开盘幅度合格 + 10:00 前不破水 + 中线在水上」这个主干上，比较几种不同买点：
  A 最早满足就买（9:35 就能买）
  B 突破窗口前高再买（要求先有震荡，再创新高）
  C 回踩缩量后再拉起买（用户原意）
  D 首次上穿中线买
并给出各买点的出场规则敏感性。
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
    """返回每个候选日的基础信息 + 各种买点的入场槽位"""
    out = []
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
            # 逐根累计最高/最低 -> 中线
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
            # 主干：第一次水位以上且中线以上，且此后不再破水
            core = None
            for k in range(9):
                if win[k][3] >= prev and mids[k] >= prev and last_below <= k and last_below <= 2:
                    core = k
                    break
            # 附加要求：10:00 之后不再破水（用全天数据检查 9:55 之后）
            later_below = any(b[3] < prev for b in bars[3:9])
            rec = {'code': code, 'pool': pool, 'date': d, 'gap': gap,
                   'core': core, 'later_below': later_below}
            # B 突破窗口内前高
            runmax = -1e18
            b_ent = None
            for k in range(2, 9):
                runmax = max(runmax, win[k - 1][1])
                if win[k][3] >= prev and mids[k] >= prev and win[k][3] > runmax and last_below <= 2:
                    b_ent = k
                    break
            rec['brk'] = b_ent
            # C 回踩（至少一次收盘价回落到窗口高点下方0.4%）后重新站上该高点
            c_ent = None
            for k in range(3, 9):
                prior_hi = max(win[j][1] for j in range(k))
                dip = any(win[j][3] < prior_hi * 0.996 for j in range(max(1, k - 5), k))
                dvol = [win[j][4] for j in range(max(1, k - 4), k)]
                upvol = [win[j][4] for j in range(0, max(2, k - 4))]
                shrink = (M(dvol) <= M(upvol) * 0.9) if upvol and dvol else False
                if dip and shrink and win[k][3] >= prev and mids[k] >= prev \
                        and win[k][3] >= prior_hi and last_below <= 2:
                    c_ent = k
                    break
            rec['pull'] = c_ent
            # D 首次上穿中线
            d_ent = None
            for k in range(1, 9):
                if win[k][3] >= prev and mids[k] >= prev and mids[k - 1] < prev \
                        and last_below <= 2:
                    d_ent = k
                    break
            rec['cross'] = d_ent
            rec['bars'] = bars
            rec['prev'] = prev
            out.append(rec)
    return out


def eval_entry(cands, key, tag, tp_sl=None):
    rows = []
    for r in cands:
        k = r.get(key)
        if k is None:
            continue
        bars = r['bars']
        px = bars[k][3]
        if px <= 0:
            continue
        post = bars[k + 1:]
        nxt = None
        rows.append({
            'date': r['date'], 'code': r['code'], 'slot': k, 'gap': r['gap'],
            'close': (bars[-1][3] / px - 1) * 100,
            'mx': (max(b[1] for b in post) / px - 1) * 100 if post else 0.0,
            'mn': (min(b[2] for b in post) / px - 1) * 100 if post else 0.0,
            'px': px, 'bars': bars, 'k': k,
        })
    if not rows:
        print(f'{tag:16s} 无样本')
        return rows
    v = [x['close'] - FEE for x in rows]
    sd = math.sqrt(sum((x - M(v)) ** 2 for x in v) / max(len(v) - 1, 1))
    slots = {}
    for x in rows:
        slots[x['slot']] = slots.get(x['slot'], 0) + 1
    dist = ' '.join(f'{35+5*k:02d}分:{n}' for k, n in sorted(slots.items()))
    print(f'{tag:16s} n={len(v):5d} 收盘卖 {M(v):+.3f}%±{1.96*sd/math.sqrt(len(v)):.3f} '
          f'胜{W(v):4.1f}% | 当日曾涨1% {W([1 if x["mx"]>=1 else 0 for x in rows]):4.1f}% '
          f'| 入场 [{dist}]')
    return rows


def main():
    files = sorted(glob.glob(POOL + '*.csv')) + sorted(glob.glob(BIG + '*.ndjson'))
    cands = scan(files)
    print(f'基础池（开盘幅度合格的日子）: {len(cands)}')

    # 三种主干口径：不管10点后是否破水 / 要求10点后不破水
    print('\n===== 买点设计对比（含全部合格日） =====')
    for key, tag in (('core', 'A 最早达标就买'), ('brk', 'B 突破前高买'),
                     ('pull', 'C 回踩缩量后买'), ('cross', 'D 首次上穿中线买')):
        eval_entry(cands, key, tag)

    print('\n===== 追加「9:55 之后也不再破水」 =====')
    strict = [r for r in cands if not r['later_below']]
    print(f'  剩余 {len(strict)} 天 ({len(strict)/len(cands)*100:.1f}%)')
    for key, tag in (('core', 'A 最早达标就买'), ('brk', 'B 突破前高买'),
                     ('pull', 'C 回踩缩量后买'), ('cross', 'D 首次上穿中线买')):
        eval_entry(strict, key, tag)

    # 出场规则：对 A 口径做敏感性
    print('\n===== 出场规则（A 口径） =====')
    rows = eval_entry(cands, 'core', 'A 重算')
    for tp, sl in ((0.8, 0.8), (1.0, 1.0), (1.5, 1.0), (2.0, 1.0), (2.5, 1.0), (3.0, 1.5)):
        res = []
        for r in rows:
            px = r['px']
            done = None
            for b in r['bars'][r['k'] + 1:]:
                if b[2] <= px * (1 - sl / 100):
                    done = -sl
                    break
                if b[1] >= px * (1 + tp / 100):
                    done = tp
                    break
            res.append(done if done is not None else r['close'])
        v = [x - FEE for x in res]
        print(f'  止盈{tp}% 止损{sl}%  均值 {M(v):+.3f}%  胜率 {W(v):.1f}%  '
              f'触发率 {(1-sum(1 for x in res if x==rows[0]["close"])/len(res))*100:.0f}%')
    # 纯尾盘卖
    v = [r['close'] - FEE for r in rows]
    print(f'  持到收盘卖        均值 {M(v):+.3f}%  胜率 {W(v):.1f}%')

    print('\n===== A 口径分年 / 分池 =====')
    byy = {}
    for r in rows:
        byy.setdefault(r['date'][:4], []).append(r)
    for y in sorted(byy):
        vv = [r['close'] - FEE for r in byy[y]]
        print(f'  {y} n={len(vv):4d} {M(vv):+.3f}% 胜率 {W(vv):.1f}%')


if __name__ == '__main__':
    main()
