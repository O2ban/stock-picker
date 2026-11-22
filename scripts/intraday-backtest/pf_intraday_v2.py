#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
日内强势股条件验证 v2 —— 先做 alpha 真实性检验
用户条件：
  A 开盘涨跌幅 [-2%, +1.5%]
  B 出手 9:35~10:15
  C 出手价在水上（>=昨收）
  D 「中」线在水上：中=(当日累计最高+当日累计最低)/2 >= 昨收
  E 窗口内有「拉起-砸下-下跌缩量」的震荡验证
  F 若曾跌破水面，须 10:00 前拉回（之后不再水下）
检验要点：
  1 命中组买入价相对当日 VWAP 的位置（可能只是买得便宜，不是真优势）
  2 同 gap 条件、同时段、同分钟位置的无条件对照
  3 分股票池（大盘 8 只 / 中小盘 20 只）看是否一致
  4 到 +1%/+1.5%/+2% 的触达率与触达用时
"""
import os, sys, glob, csv, math

FEE = 0.26
PIVOT_PCT = 0.6
VOL_SHRINK = 0.8
MIN_PULL = 0.4
GAP_LO, GAP_HI = -2.0, 1.5
SLOTS = [35, 40, 45, 50, 55, 60, 65, 70, 75]   # 窗口内 9 根 5 分钟 bar 的结束分钟


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
            if d not in days:
                days[d] = []
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
            if d not in days:
                days[d] = []
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


def pattern_done_at(win, prev):
    """返回最早满足「拉起-砸下-缩量」的 bar 索引，没有则 None。
    只使用该索引之前的 bar，不含未来信息。"""
    for k in range(len(win)):
        sub = win[:k + 1]
        piv = zigzag(sub, PIVOT_PCT)
        found = None
        for j, (i0, t0, _) in enumerate(piv):
            if t0 != 'peak':
                continue
            t_i = None
            for kk in range(j + 1, len(piv)):
                if piv[kk][1] == 'trough':
                    t_i = piv[kk][0]
                    break
            if t_i is None:
                continue
            t_h = None
            for kk in range(j - 1, -1, -1):
                if piv[kk][1] == 'trough':
                    t_h = piv[kk][0]
                    break
            peak_px, tr_px = sub[i0][3], sub[t_i][3]
            if peak_px <= 0 or tr_px <= 0:
                continue
            if (peak_px - tr_px) / peak_px * 100 < MIN_PULL:
                continue
            up_bars = sub[(t_h + 1 if t_h is not None else 0):i0 + 1]
            dn_bars = sub[i0 + 1:t_i + 1]
            if not up_bars or not dn_bars:
                continue
            up_v = sum(b[4] for b in up_bars) / len(up_bars)
            dn_v = sum(b[4] for b in dn_bars) / len(dn_bars)
            if up_v <= 0 or dn_v > up_v * VOL_SHRINK:
                continue
            found = t_i
        if found is not None:
            return k
    return None


def evaluate(win, prev, k):
    px = win[k][3]
    return px


def run(files, tag, pool_kind):
    hits = []
    ctrl = []   # 对照组：(slot_k, day_ret_to_close, ret_to_vwap)
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
            prev = days[i - 1][1][-1][3]
            if prev <= 0:
                continue
            win = bars[:9]
            gap = (win[0][0] / prev - 1) * 100
            if not (GAP_LO <= gap <= GAP_HI):
                continue
            ndays += 1
            # 当日 VWAP（用分钟量价）
            tot_v = sum(b[4] for b in bars)
            tot_a = sum((b[1] + b[2] + b[3]) / 3 * b[4] for b in bars)
            vwap = tot_a / tot_v if tot_v > 0 else None
            # 对照组：窗口内每一个槽位
            for k in range(9):
                px = win[k][3]
                if px <= 0:
                    continue
                ctrl.append((k, (bars[-1][3] / px - 1) * 100,
                             (px / vwap - 1) * 100 if vwap else 0.0))
            # 条件判定
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
            pd_at = pattern_done_at(win, prev)
            if pd_at is None:
                continue
            entry = None
            for k in range(pd_at, 9):
                if win[k][3] < prev:
                    continue
                if mids[k] < prev:
                    continue
                if last_below > k:
                    break
                if last_below > 2:
                    break
                entry = k
                break
            if entry is None:
                continue
            px = win[entry][3]
            rest = bars[entry:]
            # 触达率：买入后到收盘，5 分钟 bar 的最高价是否触及阈值
            def touch(thr):
                for bi, b in enumerate(rest):
                    if b[1] >= px * (1 + thr / 100):
                        return bi
                return None
            nxt = days[i + 1][1]
            hits.append({
                'code': code, 'date': d, 'slot': entry, 'gap': gap,
                'dev_vwap': (px / vwap - 1) * 100 if vwap else 0.0,
                'close_ret': (bars[-1][3] / px - 1) * 100,
                'next_open': (nxt[0][0] / px - 1) * 100,
                'next_close': (nxt[-1][3] / px - 1) * 100,
                't1': touch(1.0), 't15': touch(1.5), 't2': touch(2.0),
                'max_ret': (max(b[1] for b in rest) / px - 1) * 100,
            })

    def M(v):
        return sum(v) / len(v) if v else float('nan')

    def P(v, f):
        return sum(1 for x in v if f(x)) / len(v) * 100 if v else float('nan')

    print(f'\n===== {tag} | {pool_kind} =====')
    print(f'符合条件的交易日 {ndays}，命中 {len(hits)} 次 '
          f'（{len(hits)/max(ndays,1)*100:.2f}% 的日子）')
    if not hits:
        return hits
    dv = [h['dev_vwap'] for h in hits]
    cv = [c[2] for c in ctrl]
    print(f'买入价相对当日成交均价: 命中组 {M(dv):+.3f}%  对照组(同gap同窗口任意点) {M(cv):+.3f}%')
    print('  → 命中组买得比均价低多少，就是"便宜买"带来的虚增收益')
    cr = [h['close_ret'] for h in hits]
    cb = [c[1] for c in ctrl]
    print(f'买后到当日收盘: 命中组 {M(cr):+.3f}% (胜率{P(cr, lambda x: x>0):.1f}%) | '
          f'对照 {M(cb):+.3f}% (胜率{P(cb, lambda x: x>0):.1f}%)')
    # 同槽位对照
    print('  同分钟位置对照（命中组 vs 对照组）:')
    for k in range(9):
        a = [h['close_ret'] for h in hits if h['slot'] == k]
        b = [c[1] for c in ctrl if c[0] == k]
        if len(a) < 10 or not b:
            continue
        print(f'    9:{SLOTS[k]:02d}  命中 {len(a):4d} 次 均值 {M(a):+.3f}%   '
              f'对照 {len(b):5d} 次 均值 {M(b):+.3f}%   差 {M(a)-M(b):+.3f}%')
    print(f'卖次日开盘: {M([h["next_open"] for h in hits]):+.3f}% '
          f'(胜率{P([h["next_open"] for h in hits], lambda x: x>0):.1f}%)')
    print(f'卖次日收盘: {M([h["next_close"] for h in hits]):+.3f}% '
          f'(胜率{P([h["next_close"] for h in hits], lambda x: x>0):.1f}%)')
    for thr, key in ((1.0, 't1'), (1.5, 't15'), (2.0, 't2')):
        n = sum(1 for h in hits if h[key] is not None)
        print(f'当日触及 +{thr}%: {n}/{len(hits)} = {n/len(hits)*100:.1f}%')
    print(f'当日最大浮盈均值 {M([h["max_ret"] for h in hits]):+.3f}%，'
          f'最小 {min(h["max_ret"] for h in hits):+.2f}%')
    return hits


if __name__ == '__main__':
    pool = sorted(glob.glob('/home/ubuntu/stock-picker/data/min5_pool/*.csv'))
    big = sorted(glob.glob('/home/ubuntu/stock-picker/data/min5/*.ndjson'))
    h1 = run(pool, '中小盘池(20只)', '曾按振幅筛选，偏强，有幸存者偏差')
    h2 = run(big, '大盘股(8只)', '偏中性')
    h3 = run(pool + big, '合计(28只)', '')
