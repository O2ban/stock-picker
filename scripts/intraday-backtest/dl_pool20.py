import baostock as bs, os, sys, time

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/pool20.txt'
CODES = [l.strip() for l in open(SRC) if l.strip()]
OUT = '/home/ubuntu/stock-picker/data/min5_pool'
os.makedirs(OUT, exist_ok=True)

def bcode(c):
    return c[:2] + '.' + c[2:]

bs.login()
for i, c in enumerate(CODES, 1):
    fn = os.path.join(OUT, c + '.csv')
    if os.path.exists(fn) and os.path.getsize(fn) > 100000:
        print(i, c, 'skip', flush=True)
        continue
    t = time.time()
    rs = bs.query_history_k_data_plus(bcode(c), 'date,time,open,high,low,close,volume,amount',
        start_date='2020-01-01', end_date='2026-11-14', frequency='5', adjustflag='2')
    rows = []
    while rs.error_code == '0' and rs.next():
        rows.append(','.join(rs.get_row_data()))
    tmp = fn + '.part'
    with open(tmp, 'w') as f:
        f.write('\n'.join(rows))
    os.replace(tmp, fn)
    print(i, c, 'rows', len(rows), 'sec', round(time.time() - t, 1), flush=True)
bs.logout()
print('ALL DONE', flush=True)
