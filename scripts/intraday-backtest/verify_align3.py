#!/usr/bin/env python3
# 逐股逐年核对：日线前复权收盘价 与 5分钟最后一根收盘价 的比值偏移
import os, sqlite3, statistics

DB = '/home/ubuntu/kline-trainer/kline-server/data/kline.db'
MIN5 = '/home/ubuntu/stock-picker/data/min5'
CODES = ['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']

con = sqlite3.connect(DB)
cur = con.cursor()

for code in CODES:
    f = os.path.join(MIN5, code + '.ndjson')
    if not os.path.exists(f):
        print(code, 'no min5')
        continue
    # 每日最后一根5分钟收盘价（按日期取最后一个时间戳）
    day_last = {}
    with open(f) as fh:
        for line in fh:
            p = line.strip().split(',')
            if len(p) < 7: continue
            ts = p[0]
            d = ts[:8]
            day_last[d] = float(p[4])
    dates = sorted(day_last)
    cur.execute("SELECT date, close_qfq FROM daily_kline WHERE code=? AND date>=? AND date<=? ORDER BY date",
                (code, dates[0][:4]+'-'+dates[0][4:6]+'-'+dates[0][6:], dates[-1][:4]+'-'+dates[-1][4:6]+'-'+dates[-1][6:]))
    dmap = {r[0]: r[1] for r in cur.fetchall()}
    ratios_by_year = {}
    for d in dates:
        ds = d[:4]+'-'+d[4:6]+'-'+d[6:]
        if ds in dmap and dmap[ds]:
            r = day_last[d] / dmap[ds] - 1.0
            ratios_by_year.setdefault(ds[:4], []).append(r)
    print('==', code)
    for y in sorted(ratios_by_year):
        v = ratios_by_year[y]
        print('   %s  n=%4d  median=%+.4f%%  min=%+.4f%%  max=%+.4f%%' % (
            y, len(v), statistics.median(v)*100, min(v)*100, max(v)*100))
con.close()
