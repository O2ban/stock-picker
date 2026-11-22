#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v3：条件消融 + 出场规则 —— 判断哪条条件真正有价值
修正 v2 的一处偏差：买入那根 5 分钟 bar 的最高价不能再算作买入后的浮盈。
"""
import os, sys, glob, csv, math

FEE = 0.26
PIVOT_PCT = 0.6
VOL_SHRINK = 0.8
MIN_PULL = 0.4
GAP_LO, GAP_HI = -2.0, 1.5
SLOTS = [35, 40, 45, 50, 55, 60, 65, 70, 75]


def load_csv(path):
    days, order = {}, []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for row in csv.reader(f):
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
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            p = line.strip().split(",")
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


def zigzag(bars, pct):
    out = []
    if len(bars) < 2:
        return out
    hi = lo = bars[0][3]
    hi_i = lo_i = 0
    up = None
    for i, b in enumerate(bars):
        c = b[3]
        if up is None:
            if c > hi: hi, hi_i = c, i
            if c < lo: lo, lo_i = c, i
            if hi > 0 and lo > 0 and (hi - lo) / lo * 100 >= pct:
                if hi_i < lo_i:
                    out.append((lo_i, 'trough', lo)); up = True; hi, hi_i = c, i
                else:
                    out.append((hi_i, 'peak', hi)); up = False; lo, lo_i = c, i
        elif up:
            if c > hi: hi, hi_i = c, i
            elif (hi - c) / hi * 100 >= pct:
                out.append((hi_i, 'peak', hi)); up = False; lo, lo_i = c, i
        else:
            if c < lo: lo, lo_i = c, i
            elif (c - lo) / lo * 100 >= pct:
                out.append((lo_i, 'trough', lo)); up = True; hi, hi_i = c, i
    return out


def pattern_done_at(win, use_vol=True, use_pull=True):
    """最早满足「拉起-砸下(缩量)」的 bar 索引，只用该 bar 及之前的 bar。"""
    for k in range(len(win)):
        sub = win[:k + 1]
        piv = zigzag(sub, PIVOT_PCT)
        hit = None
        for j, (i0, t0, _) in enumerate(piv):
            if t0 != 'peak':
                continue
            t_i = None
            for kk in range(j + 1, len(piv)):
                if piv[kk][1] == 'trough':
                    t_i = piv[kk][0]; break
            if t_i is None:
                continue
            t_h = None
            for kk in range(j - 1, -1, -1):
                if piv[kk][1] == 'trough':
                    t_h = piv[kk][0]; break
            peak_px, tr_px = sub[i0][3], sub[t_i][3]
            if peak_px <= 0 or tr_px <= 0:
                continue
            if use_pull and (peak_px - tr_px) / peak_px * 100 < MIN_PULL:
                continue
            if use_vol:
                up_bars = sub[(t_h + 1 if t_h is not None else 0):i0 + 1]
                dn_bars = sub[i0 + 1:t_i + 1]
                if not up_bars or not dn_bars:
                    continue
                up_v = sum(b[4] for b in up_bars) / len(up_bars)
                dn_v = sum(b[4] for b in dn_bars) / len(dn_bars)
                if up_v <= 0 or dn_v > up_v * VOL_SHRINK:
                    continue
            hit = t_i
        if hit is not None:
            return k
    return None


def collect(files, opts):
    out = []
    for fp in files:
        days = load_csv(fp) if fp.endswith('.csv') else load_ndjson(fp)
        for i in range(1, len(days) - 1):
            d, bars = days[i]
            if len(bars) < 40:
                continue
            prev = days[i - 1][1][-1][3]
            if prev <= 0:
                continue
            win = bars[:9]
            gap = (win[0][0] / prev - 1) * 100
            if opts.get('gap', True) and not (GAP_LO <= gap <= GAP_HI):
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
            if opts.get('pattern', True):
                pd_at = pattern_done_at(win, opts.get('vol', True), opts.get('pull', True))
                if pd_at is None:
                    continue
            else:
                pd_at = 0
            entry = None
            for k in range(pd_at if opts.get('pattern', True) else 0, 9):
                if win[k][3] < prev and opts.get('above', True):
                    continue
                if mids[k] < prev and opts.get('mid', True):
                    continue
                if opts.get('reclaim', True):
                    if last_below > k:
                        break
                    if last_below > 2:
                        break
                entry = k
                break
            if entry is None:
                continue
            px = win[entry][3]
            if px <= 0:
                continue
            post = bars[entry + 1:]        # 买入 bar 之后的走势
            rest = bars[entry:]
            nxt = days[i + 1][1]

            def exit_rule(tp, sl):
                """当日按时序逐根走，先触止损还是先触止盈。返回 (收益%, 是否持有到收盘)"""
                for b in post:
                    lo_t = b[2] <= px * (1 - sl / 100)
                    hi_t = b[1] >= px * (1 + tp / 100)
                    if lo_t and hi_t:
                        # 同根双触，保守按先止损
                        return -sl, False
                    if lo_t:
                        return -sl, False
                    if hi_t:
                        return tp, False
                return (bars[-1][3] / px - 1) * 100, True

            rec = {'code': os.path.basename(fp)[:9], 'date': d, 'slot': entry, 'gap': gap,
                   'close_ret': (bars[-1][3] / px - 1) * 100,
                   'next_open': (nxt[0][0] / px - 1) * 100,
                   'next_close': (nxt[-1][3] / px - 1) * 100,
                   'max_after': (max(b[1] for b in post) / px - 1) * 100 if post else 0.0,
                   'min_after': (min(b[2] for b in post) / px - 1) * 100 if post else 0.0}
            for tp, sl in ((1.0, 1.0), (1.5, 1.0), (2.0, 1.0), (1.0, 0.7), (2.0, 1.5)):
                r, hold = exit_rule(tp, sl)
                rec[f'e_{tp}_{sl}'] = r
            out.append(rec)
    return out


def summ(rows, tag):
    if not rows:
        print(f'{tag:38s} 无样本')
        return
    n = len(rows)
    def M(v): return sum(v) / len(v)
    def W(v): return sum(1 for x in v if x > 0) / len(v) * 100
    cr = [r['close_ret'] - FEE for r in rows]
    sd = math.sqrt(sum((x - M(cr)) ** 2 for x in cr) / max(n - 1, 1))
    se = sd / math.sqrt(n)
    print(f'{tag:38s} n={n:5d} 收盘卖 {M(cr):+.3f}% (胜{W(cr):4.1f}%) '
          f'±{1.96*se:.3f}  次日开 {M([r["next_open"]-FEE for r in rows]):+.3f}% '
          f'次日收 {M([r["next_close"]-FEE for r in rows]):+.3f}%')


def main():
    pool = sorted(glob.glob('/home/ubuntu/stock-picker/data/min5_pool/*.csv'))
    big = sorted(glob.glob('/home/ubuntu/stock-picker/data/min5/*.ndjson'))
    files = pool + big
    base = collect(files, {})
    print(f'全条件命中 {len(base)} 次\n')

    print('— 条件消融（每次去掉一条，看样本量/收益怎么变）—')
    combos = [
        ('全部条件', {}),
        ('去掉 缩量要求', {'vol': False}),
        ('去掉 回落幅度要求', {'pull': False}),
        ('去掉 震荡形态(只要求10点前回水上+中线水上)', {'pattern': False}),
        ('去掉 中线上水', {'mid': False}),
        ('去掉 买入价在水上', {'above': False}),
        ('去掉 10点前拉回', {'reclaim': False}),
        ('去掉 开盘幅度限制', {'gap': False}),
        ('只要 开盘幅度+10点前回水上', {'pattern': False, 'mid': False}),
    ]
    for tag, o in combos:
        summ(collect(files, o), tag)

    print('\n— 出场规则对比（全条件命中，扣 0.26% 费用）—')
    for k in ('e_1.0_1.0', 'e_1.5_1.0', 'e_2.0_1.0', 'e_1.0_0.7', 'e_2.0_1.5'):
        v = [r[k] - FEE for r in base]
        print(f'  止盈{k[2:]}  均值 {sum(v)/len(v):+.3f}%  胜率 {sum(1 for x in v if x>0)/len(v)*100:.1f}%')

    print('\n— 命中后当日最大浮盈 / 最大浮亏（买入后的后续走势）—')
    ma = [r['max_after'] for r in base]
    mi = [r['min_after'] for r in base]
    print(f'  最大浮盈 均值 {sum(ma)/len(ma):+.2f}%  中位 {sorted(ma)[len(ma)//2]:+.2f}%')
    print(f'  最大浮亏 均值 {sum(mi)/len(mi):+.2f}%  中位 {sorted(mi)[len(mi)//2]:+.2f}%')
    for thr in (0.5, 1.0, 1.5, 2.0, 3.0):
        p = sum(1 for x in ma if x >= thr) / len(ma) * 100
        print(f'  当日曾涨过 +{thr}% 的比例: {p:.1f}%')

    print('\n— 分股票池 —')
    summ([r for r in base if os.path.exists('/home/ubuntu/stock-picker/data/min5_pool/' + r['code'] + '.csv')],
         '中小盘池(20只)')
    summ([r for r in base if not os.path.exists('/home/ubuntu/stock-picker/data/min5_pool/' + r['code'] + '.csv')],
         '大盘股(8只)')

    print('\n— 按年份 —')
    byy = {}
    for r in base:
        byy.setdefault(r['date'][:4], []).append(r)
    for y in sorted(byy):
        v = [r['close_ret'] - FEE for r in byy[y]]
        print(f'  {y}  n={len(v):4d}  {sum(v)/len(v):+.3f}%  胜率 {sum(1 for x in v if x>0)/len(v)*100:.1f}%')

    print('\n— 真实命中样例（最近 12 次，供人工看图核对）—')
    for r in sorted(base, key=lambda x: x['date'])[-12:]:
        print(f'  {r["code"]} {r["date"]} 入场9:{SLOTS[r["slot"]]} '
              f'开盘差{r["gap"]:+.2f}% 买后涨过+{r["max_after"]:+.2f}% '
              f'跌过{r["min_after"]:+.2f}% 收盘{r["close_ret"]:+.2f}% 次日开{r["next_open"]:+.2f}%')


if __name__ == '__main__':
    main()
