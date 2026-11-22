#!/usr/bin/env python3
# 判定 min5 到底是复权还是不复权：分别与 daily 的 close(原始) / close_qfq(前复权) / close_hfq(后复权) 比
import os, sqlite3, statistics

DB = '/home/ubuntu/kline-trainer/kline-server/data/kline.db'
MIN5 = '/home/ubuntu/stock-picker/data/min5'
CODES = ['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']

con = sqlite3.connect(DB)
cur = con.cursor()
cur.execute("PRAGMA table_info(daily_kline)")
cols = [r[1] for r in cur.fetchall()]
print('daily_kline cols:', cols)

for code in CODES:
    f = os.path.join(MIN5, code + '.ndjson')
    if not os.path.exists(f):
        continue
    day_last = {}
    with open(f) as fh:
        for line in fh:
            p = line.strip().split(',')
            if len(p) < 7: continue
            day_last[p[0][:8]] = float(p[4])
    dates = sorted(day_last)
    d0 = dates[0][:4]+'-'+dates[0][4:6]+'-'+dates[0][6:]
    d1 = dates[-1][:4]+'-'+dates[-1][4:6]+'-'+dates[-1][6:]
    cur.execute("SELECT date, close_raw, close_qfq, close_hfq FROM daily_kline WHERE code=? AND date>=? AND date<=? ORDER BY date", (code, d0, d1))
    rows = {r[0]: r[1:] for r in cur.fetchall()}

    stats = {'raw': [], 'qfq': [], 'hfq': []}
    for d in dates:
        ds = d[:4]+'-'+d[4:6]+'-'+d[6:]
        if ds not in rows: continue
        raw, qfq, hfq = rows[ds]
        v = day_last[d]
        for k, base in (('raw', raw), ('qfq', qfq), ('hfq', hfq)):
            if base:
                stats[k].append(abs(v/base - 1.0))
    out = code
    for k in ('raw', 'qfq', 'hfq'):
        v = stats[k]
        out += '  %s中位误差=%.4f%%' % (k, statistics.median(v)*100 if v else float('nan'))
    print(out)
con.close()
