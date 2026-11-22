#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
单票日内做T 回测 v2（bt4 的对照增强版）

在 bt4 基础上只改三件事，其余口径完全一致：
 1. 计入费用：单边合计 0.13%（买卖两侧加总），所有收益都扣费后给出
 2. 买入深度两套口径并行：
    - k * 60日平均振幅（k = 0.6/0.8/1.0/1.2/1.5/2.0）
    - 固定百分比深度（2% / 3% / 4%）
 3. 均线过滤做四组对照，单独量化这条过滤的贡献：
    - ma5   : 前一日收盘 > 前一日 5 日均线（bt4 原口径）
    - none  : 不过滤
    - ma10  : 前一日收盘 > 前一日 10 日均线
    - ma20  : 前一日收盘 > 前一日 20 日均线

卖出方式：
 - next_open  次日开盘价
 - next_close 次日收盘价
 - tp1        次日盘中触及 +1% 即卖，否则收盘卖
 - mid        次日盘中触及「买入日中间价」即卖，否则收盘卖
 - mid_s3     mid 规则 + 次日盘中先跌 3% 则止损（先判断止损，保守）

只用单日振幅口径（两日振幅 bt4 已证明无优势）。
"""
import json, os
from collections import defaultdict

D = os.path.dirname(os.path.abspath(__file__))
M5 = os.path.join(D, 'min5')

FEE = 0.0013

KS = [0.6, 0.8, 1.0, 1.2, 1.5, 2.0]
FIXED = [0.02, 0.03, 0.04]
FILTERS = ['ma5', 'none', 'ma10', 'ma20']
SELLS = ['next_open', 'next_close', 'tp1', 'mid', 'mid_s3']


def load_daily(path):
    with open(path) as f:
        rows = json.load(f)
    byday = defaultdict(list)
    for r in rows:
        byday[r[0]].append(r)
    days = []
    for d in sorted(byday.keys()):
        bars = sorted(byday[d], key=lambda x: x[1])
        days.append({
            'date': d,
            'o': float(bars[0][2]),
            'h': max(float(b[3]) for b in bars),
            'l': min(float(b[4]) for b in bars),
            'c': float(bars[-1][5]),
            'bars': bars,
        })
    return days


def ema_ma(days, n):
    out = [None] * len(days)
    for i in range(n - 1, len(days)):
        out[i] = sum(days[j]['c'] for j in range(i - n + 1, i + 1)) / n
    return out


def run_one(path):
    days = load_daily(path)
    n = len(days)
    # 预计算单日振幅与 60 日均值
    amp1 = [None] * n
    for i in range(1, n):
        pc = days[i - 1]['c']
        if pc > 0:
            amp1[i] = (days[i]['h'] - days[i]['l']) / pc
    amp60 = [None] * n
    for i in range(60, n):
        vals = [amp1[j] for j in range(i - 59, i + 1) if amp1[j] is not None]
        if len(vals) >= 40:
            amp60[i] = sum(vals) / len(vals)

    mas = {'ma5': ema_ma(days, 5), 'ma10': ema_ma(days, 10), 'ma20': ema_ma(days, 20)}

    # res[filter][depth_label] = {sell: [rets]}
    res = {f: defaultdict(lambda: {s: [] for s in SELLS}) for f in FILTERS}
    # 记录可交易日数（分母），用于看过滤有多严
    trade_days = {f: 0 for f in FILTERS}
    trig_days = {f: 0 for f in FILTERS}
    # 单独统计：无过滤下所有「可买日」的中间价回归率
    mid_touch_all = [0, 0]

    for i in range(62, n - 1):
        pc = days[i - 1]['c']
        if pc <= 0:
            continue
        nxt = days[i + 1]
        mid = (days[i]['h'] + days[i]['l']) / 2.0
        a = amp60[i]

        for f in FILTERS:
            if f != 'none':
                m = mas[f][i - 1]
                if m is None:
                    continue
                if days[i - 1]['c'] <= m:
                    continue
            trade_days[f] += 1

        depths = []
        if a:
            depths += [(f'k={k}', pc * k * a) for k in KS]
        depths += [(f'fix={p}', pc * p) for p in FIXED]

        for f in FILTERS:
            if f != 'none':
                m = mas[f][i - 1]
                if m is None or days[i - 1]['c'] <= m:
                    continue
            fired = False
            for lbl, drop in depths:
                trig = pc - drop
                if days[i]['l'] > trig:
                    continue
                fired = True
                buy = trig
                rec = {}
                rec['next_open'] = nxt['o'] / buy - 1
                rec['next_close'] = nxt['c'] / buy - 1
                # 次日盘中先后顺序：5分钟 bar 逐根走
                for s, tp in (('tp1', buy * 1.01), ('mid', mid)):
                    got = None
                    for b in nxt['bars']:
                        if float(b[3]) >= tp:
                            got = tp
                            break
                    rec[s] = (got / buy - 1) if got is not None else (nxt['c'] / buy - 1)
                # mid + 3% 止损：先看当天是否先跌破 -3%
                sl = buy * 0.97
                out = None
                for b in nxt['bars']:
                    if float(b[4]) <= sl:
                        out = sl
                        break
                    if float(b[3]) >= mid:
                        out = mid
                        break
                rec['mid_s3'] = (out / buy - 1) if out is not None else (nxt['c'] / buy - 1)
                for s in SELLS:
                    res[f][lbl][s].append(rec[s] - FEE)
            if fired:
                trig_days[f] += 1

    # 中间价回归率（无过滤，所有可买日）
    for i in range(62, n - 1):
        nxt = days[i + 1]
        if not nxt['bars']:
            continue
        mid = (days[i]['h'] + days[i]['l']) / 2.0
        mid_touch_all[1] += 1
        if any(float(b[3]) >= mid for b in nxt['bars']):
            mid_touch_all[0] += 1

    return res, trade_days, trig_days, mid_touch_all


def stat(v):
    if not v:
        return None
    w = [x for x in v if x > 0]
    l = [x for x in v if x <= 0]
    win = len(w) / len(v) * 100
    aw = sum(w) / len(w) * 100 if w else 0.0
    al = sum(l) / len(l) * 100 if l else 0.0
    exp = sum(v) / len(v) * 100
    pf = (aw * len(w)) / abs(al * len(l)) if l and al != 0 else float('inf')
    return len(v), win, aw, al, pf, exp


def main():
    files = sorted(f for f in os.listdir(M5) if f.endswith('.json'))
    tot = {f: defaultdict(lambda: {s: [] for s in SELLS}) for f in FILTERS}
    td_sum = {f: 0 for f in FILTERS}
    tr_sum = {f: 0 for f in FILTERS}
    mid_all = [0, 0]

    per = {}
    for fn in files:
        name = fn.replace('.json', '')
        r, td, tr, mt = run_one(os.path.join(M5, fn))
        per[name] = (r, td, tr)
        for f in FILTERS:
            td_sum[f] += td[f]
            tr_sum[f] += tr[f]
            for lbl in r[f]:
                for s in SELLS:
                    tot[f][lbl][s].extend(r[f][lbl][s])
        mid_all[0] += mt[0]
        mid_all[1] += mt[1]

    print('=' * 100)
    print(f'【总览】8 只票合计，费用已计（每笔扣 {FEE*100:.2f}%）')
    if mid_all[1]:
        print(f'次日盘中能触及买入日中间价的比例：{mid_all[0]/mid_all[1]*100:.1f}%  (样本 {mid_all[1]} 天)')
    print('可交易日/触发日（过滤越松可交易日越多）：')
    for f in FILTERS:
        print(f'  {f:<5} 可交易 {td_sum[f]:>6} 天，实际触发 {tr_sum[f]:>6} 天')
    print('=' * 100)

    for f in FILTERS:
        print(f'\n### 过滤 = {f}')
        lbls = [f'k={k}' for k in KS] + [f'fix={p}' for p in FIXED]
        print(f'{"深度":<9}{"卖出":<11}{"笔数":>7}{"胜率":>8}{"均盈":>8}{"均亏":>8}{"PF":>7}{"期望":>9}')
        for lbl in lbls:
            for s in SELLS:
                st = stat(tot[f][lbl][s])
                if not st:
                    continue
                print(f'{lbl:<9}{s:<11}{st[0]:>7}{st[1]:>7.1f}%{st[2]:>+7.2f}%{st[3]:>+7.2f}%'
                      f'{st[4]:>7.2f}{st[5]:>+8.3f}%')

    # 单票分化：取几个代表性组合
    print('\n' + '=' * 100)
    print('【单票分化】过滤=none，卖法=mid 与 next_close')
    print(f'{"股票":<12}{"深度":<9}{"卖法":<11}{"笔数":>7}{"胜率":>8}{"期望":>9}')
    for name, (r, td, tr) in per.items():
        for lbl in ['k=1.0', 'k=1.2', 'fix=0.03']:
            for s in ['mid', 'next_close']:
                st = stat(r['none'][lbl][s])
                if not st:
                    continue
                print(f'{name:<12}{lbl:<9}{s:<11}{st[0]:>7}{st[1]:>7.1f}%{st[5]:>+8.3f}%')


if __name__ == '__main__':
    main()
