#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 bt4 的单票日内低吸回测结果导出成「复盘页面」可读的数据文件。

规则与 bt4.py 完全一致：
 - 用 5 分钟数据自聚合日线
 - amp60 = 60日平均振幅 mean((high-low)/prev_close)
 - 前一日收盘 <= 前一日 ma5 则当日不交易
 - 触发价 trig = prev_close * (1 - k*amp60)，当日最低价触及即按 trig 成交
 - 次日卖出：开盘价 / 收盘价 / 触及当日中间价

输出：public/bt-view/<code>.json
  { code, name, k: [..], modes: [..],
    days: [[date,o,h,l,c], ...],
    ma5: [v|null, ...],
    trades: { "1.0": { "next_close": [[i,buy,sell,retPct,trig,mid], ...] } } }
i 为买入日在 days 中的下标，卖出恒为 i+1。
"""
import json, os, sys
from collections import defaultdict

D = os.path.dirname(os.path.abspath(__file__))
M5 = os.path.join(D, 'min5')
OUT = os.path.normpath(os.path.join(D, '..', '..', 'public', 'bt-view'))

KS = [0.6, 0.8, 1.0, 1.2]
MODES = ['next_open', 'next_close', 'mid']
NAMES = {
    'sh_600000': '浦发银行', 'sh_600519': '贵州茅台', 'sh_601318': '中国平安',
    'sz_000001': '平安银行', 'sz_000858': '五粮液', 'sz_002594': '比亚迪',
    'sz_300059': '东方财富', 'sz_300750': '宁德时代',
}


def load_daily(path):
    with open(path) as f:
        rows = json.load(f)
    byday = defaultdict(list)
    for r in rows:
        byday[r[0]].append([r[1], float(r[2]), float(r[3]), float(r[4]), float(r[5]), float(r[6])])
    days = []
    for d in sorted(byday.keys()):
        bars = sorted(byday[d], key=lambda x: x[0])
        days.append({
            'date': d,
            'o': bars[0][1],
            'h': max(b[2] for b in bars),
            'l': min(b[3] for b in bars),
            'c': bars[-1][4],
            'bars': bars,
        })
    return days


def build(path, code):
    days = load_daily(path)
    n = len(days)
    amp1 = [None] * n
    ma5 = [None] * n
    for i in range(1, n):
        pc = days[i - 1]['c']
        if pc > 0:
            amp1[i] = (days[i]['h'] - days[i]['l']) / pc
    for i in range(4, n):
        ma5[i] = sum(days[j]['c'] for j in range(i - 4, i + 1)) / 5.0

    amp60 = [None] * n
    for i in range(60, n):
        vals = [amp1[j] for j in range(i - 59, i + 1) if amp1[j] is not None]
        if len(vals) >= 40:
            amp60[i] = sum(vals) / len(vals)

    trades = {('%g' % k): {m: [] for m in MODES} for k in KS}
    for i in range(62, n - 1):
        if ma5[i - 1] is None or days[i - 1]['c'] <= ma5[i - 1]:
            continue
        a = amp60[i]
        if a is None or a <= 0:
            continue
        pc = days[i - 1]['c']
        nxt = days[i + 1]
        mid = (days[i]['h'] + days[i]['l']) / 2.0
        for k in KS:
            trig = pc * (1 - k * a)
            if days[i]['l'] > trig:
                continue
            buy = trig
            for m in MODES:
                if m == 'next_open':
                    sell = nxt['o']
                elif m == 'next_close':
                    sell = nxt['c']
                else:
                    sell = nxt['c']
                    for b in nxt['bars']:
                        if b[2] >= mid:
                            sell = mid
                            break
                ret = (sell / buy - 1) * 100
                trades['%g' % k][m].append([
                    i, round(buy, 3), round(sell, 3), round(ret, 3),
                    round(trig, 3), round(mid, 3),
                ])

    return {
        'code': code,
        'name': NAMES.get(code, code),
        'k': KS,
        'modes': MODES,
        'days': [[d['date'], round(d['o'], 2), round(d['h'], 2), round(d['l'], 2), round(d['c'], 2)]
                 for d in days],
        'ma5': [round(v, 2) if v is not None else None for v in ma5],
        'trades': trades,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    files = sorted(f for f in os.listdir(M5) if f.endswith('.json'))
    index = []
    for f in files:
        code = f.replace('.json', '')
        data = build(os.path.join(M5, f), code)
        dst = os.path.join(OUT, code + '.json')
        with open(dst, 'w') as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
        idx = {'code': code, 'name': data['name'],
               'start': data['days'][0][0], 'end': data['days'][-1][0],
               'counts': {k: {m: len(v) for m, v in data['trades'][k].items()} for k in data['trades']}}
        index.append(idx)
        print(f'{code} {data["name"]} 日线 {len(data["days"])} 天 -> {os.path.getsize(dst)/1024:.0f}KB')
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump({'stocks': index, 'k': KS, 'modes': MODES}, fh, ensure_ascii=False, indent=1)
    print('done ->', OUT)


if __name__ == '__main__':
    main()
