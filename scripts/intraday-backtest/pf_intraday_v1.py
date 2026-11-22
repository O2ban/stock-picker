#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
日内强势股筛选条件验证（5 分钟数据）
条件（用户口径）：
  1. 开盘涨跌幅在 [-2%, +1.5%]，允许平开/低开
  2. 出手时间 9:35 ~ 10:15
  3. 出手时价格在水上（>= 昨收）
  4. 「中」线在水上：中 = (当日累计最高 + 当日累计最低)/2 >= 昨收
  5. 窗口内必须走出「拉起 -> 砸下 -> 下跌缩量」的震荡验证
  6. 若盘中曾跌破水面，必须 10:00 前拉回（之后不允许再水下）
衡量：买入后当日剩余走势 / 次日走势，与「同期无脑买入」对照。
"""
import os, sys, glob, csv, math

FEE = 0.26          # 双边费用（千分比，与之前回测口径一致）
PIVOT_PCT = 0.6     # zigzag 阈值（%）
VOL_SHRINK = 0.8    # 回落段均量 / 拉升段均量 上限
MIN_PULL = 0.4      # 从高点回落的最小幅度（%）
GAP_LO, GAP_HI = -2.0, 1.5


def load_csv(path):
    days = {}
    order = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for row in csv.reader(f):
            if len(row) < 8:
                continue
            d = row[0].strip()
            try:
                o, h, l, c, v = (float(row[2]), float(row[3]), float(row[4]),
                                 float(row[5]), float(row[6]))
            except ValueError:
                continue
            if d not in days:
                days[d] = []
                order.append(d)
            days[d].append((o, h, l, c, v))
    return [(d, days[d]) for d in order]


def load_ndjson(path):
    days = {}
    order = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            p = line.strip().split(",")
            if len(p) < 7:
                continue
            d = p[0][:8]
            try:
                o, h, l, c, v = (float(p[1]), float(p[2]), float(p[3]),
                                 float(p[4]), float(p[5]))
            except ValueError:
                continue
            if d not in days:
                days[d] = []
                order.append(d)
            days[d].append((o, h, l, c, v))
    return [(d, days[d]) for d in order]


def zigzag(bars, pct):
    """返回 [(idx, 'peak'|'trough', price)]"""
    out = []
    if len(bars) < 2:
        return out
    hi = lo = bars[0][3]
    hi_i = lo_i = 0
    up = None
    for i, b in enumerate(bars):
        c = b[3]
        if up is None:
            if c > hi:
                hi, hi_i = c, i
            if c < lo:
                lo, lo_i = c, i
            if hi > 0 and lo > 0:
                if (hi - lo) / lo * 100 >= pct:
                    if hi_i < lo_i:
                        out.append((lo_i, 'trough', lo))
                        up = True
                        hi, hi_i = c, i
                    else:
                        out.append((hi_i, 'peak', hi))
                        up = False
                        lo, lo_i = c, i
        elif up:
            if c > hi:
                hi, hi_i = c, i
            elif (hi - c) / hi * 100 >= pct:
                out.append((hi_i, 'peak', hi))
                up = False
                lo, lo_i = c, i
        else:
            if c < lo:
                lo, lo_i = c, i
            elif (c - lo) / lo * 100 >= pct:
                out.append((lo_i, 'trough', lo))
                up = True
                hi, hi_i = c, i
    return out


def check_window(win, prev):
    """win: 当日 9:35-10:15 的 9 根 5 分钟 bar。返回 (入场索引 or None, 诊断)"""
    hi = -1e18
    lo = 1e18
    mids = []
    for b in win:
        hi = max(hi, b[1])
        lo = min(lo, b[2])
        mids.append((hi + lo) / 2)

    # 曾跌破水面的最晚时间（收盘价口径），超过 9:55 就不能再出手
    last_below = -1
    for i, b in enumerate(win):
        if b[3] < prev:
            last_below = i

    piv = zigzag(win, PIVOT_PCT)
    # 找最后一次「peak -> trough」且 trough 缩量的组合
    ok_pattern_idx = None
    for j, (i0, t0, _) in enumerate(piv):
        if t0 != 'peak':
            continue
        t_i = t_h = None
        for k in range(j + 1, len(piv)):
            if piv[k][1] == 'trough':
                t_i, _, _ = piv[k]
                break
        for k in range(j - 1, -1, -1):
            if piv[k][1] == 'trough':
                t_h = piv[k][0]
                break
        if t_i is None:
            continue
        peak_px = win[i0][3]
        trough_px = win[t_i][3]
        if trough_px <= 0:
            continue
        pull = (peak_px - trough_px) / peak_px * 100
        if pull < MIN_PULL:
            continue
        # 量：拉升段 (t_h .. i0] 均量 vs 回落段 (i0 .. t_i] 均量
        up_bars = win[(t_h + 1 if t_h is not None else 0):i0 + 1]
        dn_bars = win[i0 + 1:t_i + 1]
        if not up_bars or not dn_bars:
            continue
        up_v = sum(b[4] for b in up_bars) / len(up_bars)
        dn_v = sum(b[4] for b in dn_bars) / len(dn_bars)
        if up_v <= 0 or dn_v > up_v * VOL_SHRINK:
            continue
        ok_pattern_idx = t_i

    if ok_pattern_idx is None:
        return None, 'no_pattern'

    for k in range(len(win)):
        b = win[k]
        if b[3] < prev:
            continue
        if mids[k] < prev:
            continue
        if ok_pattern_idx > k:
            continue
        if last_below > k:
            continue
        if last_below > 2:     # 跌破水面发生在 10:00 之后
            continue
        return k, 'ok'
    return None, 'no_entry'


def analyze(files, tag):
    rows = []
    base = []
    ndays = 0
    for fp in files:
        sys.stderr.write('.')
        sys.stderr.flush()
        days = load_csv(fp) if fp.endswith('.csv') else load_ndjson(fp)
        code = os.path.basename(fp).split('.')[0]
        for i in range(1, len(days) - 1):
            d, bars = days[i]
            if len(bars) < 40:
                continue
            ndays += 1
            prev = days[i - 1][1][-1][3]
            if prev <= 0:
                continue
            win = bars[:9]
            gap = (win[0][0] / prev - 1) * 100
            if not (GAP_LO <= gap <= GAP_HI):
                continue
            # 基准：窗口内每根都买，看当日收盘
            for k in range(len(win)):
                px = win[k][3]
                if px <= 0:
                    continue
                base.append((bars[-1][3] / px - 1) * 100)
            k, why = check_window(win, prev)
            if k is None:
                continue
            px = win[k][3]
            close = bars[-1][3]
            day_hi = max(b[1] for b in bars[k:])
            nd = days[i + 1][1]
            rows.append({
                'code': code, 'date': d, 'k': k, 'gap': gap,
                'buy': px, 'close_ret': (close / px - 1) * 100,
                'day_hi_ret': (day_hi / px - 1) * 100,
                'next_open': (nd[0][0] / px - 1) * 100,
                'next_close': (nd[-1][3] / px - 1) * 100,
                'prev': prev,
            })
    print(f'=== {tag} ===')
    print(f'股票 {len(files)} 只，交易日 {ndays} 天，基准样本 {len(base)} 个买入点')
    if base:
        print(f'基准(窗口内任意买入, 当日收盘卖): 均值 {sum(base)/len(base):+.3f}%  '
              f'正收益率 {sum(1 for x in base if x>0)/len(base)*100:.1f}%')
    if not rows:
        print('无命中')
        return rows
    n = len(rows)
    print(f'命中 {n} 次（占交易日 {n/ndays*100:.2f}%）')
    def stat(key, extra=0.0):
        v = [r[key] - extra for r in rows]
        m = sum(v) / len(v)
        sd = math.sqrt(sum((x - m) ** 2 for x in v) / len(v)) if len(v) > 1 else 0
        win = sum(1 for x in v if x > 0) / len(v) * 100
        return f'{key:12s} 均值 {m:+.3f}%  胜率 {win:5.1f}%  标准差 {sd:.2f}'
    print(stat('day_hi_ret'))
    print(stat('close_ret', FEE))
    print(stat('next_open', FEE))
    print(stat('next_close', FEE))
    # 按入场时点
    for k in range(9):
        sub = [r for r in rows if r['k'] == k]
        if not sub:
            continue
        v = [r['close_ret'] - FEE for r in sub]
        print(f'  9:{35+5*k:02d} 入场 {len(sub):5d} 次  当日收盘均值 {sum(v)/len(v):+.3f}%  '
              f'胜率 {sum(1 for x in v if x>0)/len(v)*100:.1f}%')
    return rows


if __name__ == '__main__':
    pool = sorted(glob.glob('/home/ubuntu/stock-picker/data/min5_pool/*.csv'))
    big = sorted(glob.glob('/home/ubuntu/stock-picker/data/min5/*.ndjson'))
    allf = pool + big
    if len(sys.argv) > 1:
        allf = sys.argv[1:]
    analyze(allf, '全部本地分钟数据')
