#!/usr/bin/env python3
# 检查 min5 内部是否自洽：相邻交易日 昨收->今开 的跳空分布，除权日会出现异常大跳空
import os, statistics

MIN5 = '/home/ubuntu/stock-picker/data/min5'
CODES = ['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']

for code in CODES:
    f = os.path.join(MIN5, code + '.ndjson')
    days = {}
    order = []
    with open(f) as fh:
        for line in fh:
            p = line.strip().split(',')
            if len(p) < 7: continue
            d = p[0][:8]
            if d not in days:
                days[d] = [float(p[1]), float(p[2]), float(p[3]), float(p[4])]  # o,h,l,c
                order.append(d)
            else:
                days[d][1] = max(days[d][1], float(p[2]))
                days[d][2] = min(days[d][2], float(p[3]))
                days[d][3] = float(p[4])
    gaps = []
    for i in range(1, len(order)):
        pc = days[order[i-1]][3]
        o = days[order[i]][0]
        if pc > 0:
            gaps.append((o/pc - 1) * 100)
    ab = sorted(abs(g) for g in gaps)
    big = [g for g in gaps if abs(g) > 5]
    print('%s 天数=%d  跳空中位=%.3f%%  p95=%.3f%%  超5%%跳空数=%d  %s' % (
        code, len(order), statistics.median(gaps), ab[int(len(ab)*0.95)], len(big),
        ['%.1f' % g for g in big[:6]]))
