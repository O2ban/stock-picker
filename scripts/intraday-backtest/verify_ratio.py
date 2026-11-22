#!/usr/bin/env python3
# 检查 min5 与 daily_qfq 的比值是否稳定（若稳定，则只需统一用 min5 内部价格即可）
import os, sqlite3, statistics

DB = '/home/ubuntu/kline-trainer/kline-server/data/kline.db'
MIN5 = '/home/ubuntu/stock-picker/data/min5'
CODES = ['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']

con = sqlite3.connect(DB); cur = con.cursor()
for code in CODES:
    f = os.path.join(MIN5, code + '.ndjson')
    day_last = {}
    with open(f) as fh:
        for line in fh:
            p = line.strip().split(',')
            if len(p) < 7: continue
            day_last[p[0][:8]] = float(p[4])
    dates = sorted(day_last)
    d0 = dates[0][:4]+'-'+dates[0][4:6]+'-'+dates[0][6:]
    d1 = dates[-1][:4]+'-'+dates[-1][4:6]+'-'+dates[-1][6:]
    cur.execute("SELECT date, close_qfq FROM daily_kline WHERE code=? AND date>=? AND date<=? ORDER BY date", (code, d0, d1))
    rows = dict(cur.fetchall())
    ratios = []
    for d in dates:
        ds = d[:4]+'-'+d[4:6]+'-'+d[6:]
        if ds in rows and rows[ds]:
            ratios.append(day_last[d]/rows[ds])
    if not ratios: continue
    print('%s  n=%d  ratio中位=%.5f  min=%.5f  max=%.5f  极差=%.4f%%' % (
        code, len(ratios), statistics.median(ratios), min(ratios), max(ratios),
        (max(ratios)-min(ratios))/statistics.median(ratios)*100))
con.close()
