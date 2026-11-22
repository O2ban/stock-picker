#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""严格对照：止盈/止损规则的全市场同分钟基准
策略层某分钟 i 买入、按规则 R 卖出，其对照必须是：
全市场所有股票在同一分钟 i 买入、也按同一规则 R 卖出 的平均毛收益。
否则"止盈"看起来赚钱，只是因为不同卖出时点的行情不同。
"""
import gzip, json
from collections import defaultdict

store = json.load(gzip.open('/tmp/tl_all.json.gz', 'rt', encoding='utf-8'))
S = []
for code, d in store.items():
    s, pts = d['s'], d['p']
    P = [p[1] for p in pts]
    if min(P) <= 0 or len(P) < 60: continue
    S.append({'code': code, 'P': P, 'close': P[-1]})
print(f'样本 {len(S)} 只')

RULES = {
    '持到收盘': lambda P, i: P[-1],
    '赚1%止盈': lambda P, i: next((P[k] for k in range(i+1, len(P)) if P[k]/P[i]-1 >= 0.01), P[-1]),
    '亏1%止损': lambda P, i: next((P[k] for k in range(i+1, len(P)) if P[k]/P[i]-1 <= -0.01), P[-1]),
    '赚1%或亏1%': lambda P, i: next((P[k] for k in range(i+1, len(P)) if abs(P[k]/P[i]-1) >= 0.01), P[-1]),
}


def trail(P, i, back=0.01):
    peak = P[i]
    for k in range(i+1, len(P)):
        peak = max(peak, P[k])
        if P[k]/peak - 1 <= -back: return P[k]
    return P[-1]


RULES['回撤1%卖'] = trail

# 基准：对每个规则、每个分钟 i，全市场平均毛收益
BENCH = {}
for name, fn in RULES.items():
    acc = defaultdict(list)
    for x in S:
        P = x['P']
        for i in range(0, len(P)):
            acc[i].append(fn(P, i) / P[i] - 1)
    BENCH[name] = {i: sum(v)/len(v) for i, v in acc.items()}
    print(f'  基准已算：{name}')

json.dump({k: {str(i): v for i, v in d.items()} for k, d in BENCH.items()},
          open('/tmp/bench_rules.json', 'w'))
print('已存 /tmp/bench_rules.json')

print()
print('对照示例：全市场各规则的平均毛收益（9:35~10:15 各分钟买入的均值）')
for name in RULES:
    d = BENCH[name]
    vals = [d[i] for i in range(5, 60) if i in d]
    print(f'  {name:12s}{sum(vals)/len(vals)*100:+7.3f}%')
