import baostock as bs, json, os, sys
codes = ['sz.000001','sh.600519','sz.300750','sz.002594','sh.600000','sz.000858','sh.601318','sz.300059']
bs.login()
os.makedirs('min5', exist_ok=True)
for c in codes:
    out = 'min5/%s.json' % c.replace('.','_')
    if os.path.exists(out):
        print('skip', c); continue
    rs = bs.query_history_k_data_plus(c,'date,time,open,high,low,close,volume,amount',
        start_date='2020-01-01', end_date='2026-11-14', frequency='5', adjustflag='2')
    rows=[]
    while rs.error_code=='0' and rs.next():
        rows.append(rs.get_row_data())
    json.dump(rows, open(out,'w'))
    print(c, 'rows', len(rows), rows[0][:2] if rows else None, rows[-1][:2] if rows else None)
bs.logout()
