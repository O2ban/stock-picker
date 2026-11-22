import sqlite3, os, sys, math
from collections import Counter

DB = '/home/ubuntu/kline-trainer/kline-server/data/kline.db'
MIN5 = '/home/ubuntu/stock-picker/data/min5'
FEE = 0.26
CODES = ['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']

def load_daily(code):
    c = sqlite3.connect(DB)
    rows = c.execute("""select date,open_qfq,high_qfq,low_qfq,close_qfq,vol
                        from daily_kline where code=? order by date""", (code,)).fetchall()
    c.close()
    out = []
    for d,o,h,l,cl,v in rows:
        if None in (o,h,l,cl) or cl <= 0: continue
        out.append(dict(date=d,o=o,h=h,l=l,c=cl,v=v or 0))
    for i in range(1,len(out)):
        pc = out[i-1]['c']; d = out[i]
        d['amp'] = (d['h']-d['l'])/pc*100 if pc else 0
        d['body'] = (d['c']-d['o'])/pc*100 if pc else 0
    if out: out[0]['amp']=out[0]['body']=0
    return out

def load_min5(code):
    path = os.path.join(MIN5, code + '.ndjson')
    if not os.path.exists(path): return None
    bydate = {}
    with open(path) as f:
        for line in f:
            p = line.strip().split(',')
            if len(p) < 6: continue
            t = p[0]
            if len(t) < 12: continue
            try: bar = (int(t[8:12]), float(p[1]), float(p[2]), float(p[3]), float(p[4]))
            except: continue
            bydate.setdefault(t[:8], []).append(bar)
    for k in bydate: bydate[k].sort()
    return bydate

def dkey(d): return d.replace('-','')

def simulate(bars, entry_close, tp, sl):
    tp_px = entry_close*(1+tp/100); sl_px = entry_close*(1-sl/100)
    for hhmm,o,h,l,c in bars:
        if hhmm == 930:
            if o >= tp_px: return (o/entry_close-1)*100, 'T跳空'
            if o <= sl_px: return (o/entry_close-1)*100, 'S跳空'
        hit_s = l <= sl_px; hit_t = h >= tp_px
        if hit_s and hit_t: return -sl, 'S先'
        if hit_t: return tp, 'T'
        if hit_s: return -sl, 'S'
    return (bars[-1][4]/entry_close-1)*100, '收盘'

def ma(arr, i, n):
    if i+1 < n: return None
    return sum(arr[i-n+1:i+1])/n

def check(days, i, cfg):
    d = days[i]
    closes = [x['c'] for x in days]
    m5 = ma(closes, i, 5); m20 = ma(closes, i, 20)
    if m5 is None or m20 is None: return None
    if not (d['c'] > m5 and d['c'] > m20): return None
    # 近 lookback 日内、振幅>thr 的「阳线」日
    lo = max(0, i-cfg['lookback']+1)
    hi = [j for j in range(lo, i+1) if days[j]['amp'] > cfg['amp_thr']]
    if cfg.get('yang_only', True):
        hi = [j for j in hi if days[j]['c'] > days[j]['o']]
    if cfg.get('ampday_above_ma20'):
        hi = [j for j in hi if (ma(closes, j, 20) or 0) < days[j]['c']]
    if len(hi) < cfg['min_cnt']: return None
    if i >= 5:
        v5 = sum(x['v'] for x in days[i-5:i])/5
        if v5 > 0 and d['v'] > cfg['vol_ratio']*v5: return None
    if abs(d['body']) > cfg['body_max']: return None
    return True

def run(cfg, tp=3.0, sl=1.0):
    res = []; per = {}
    for code in CODES:
        days = load_daily(code); m5 = load_min5(code)
        if not days or not m5: continue
        n_code = 0; stop = 0.0
        for i in range(30, len(days)-1):
            if not check(days, i, cfg): continue
            nb = m5.get(dkey(days[i+1]['date']))
            if not nb: continue
            r, why = simulate(nb, days[i]['c'], tp, sl)
            res.append((code, days[i]['date'], r, why))
            n_code += 1; stop += r - FEE
        if n_code: per[code] = (n_code, stop/n_code)
    if not res: return None
    n = len(res); tot = sum(x[2]-FEE for x in res)
    win = sum(1 for x in res if x[2]-FEE > 0)
    return dict(n=n, avg=tot/n, win=win/n*100, total=tot, per=per, why=Counter(x[3] for x in res))

if __name__ == '__main__':
    base = dict(lookback=100, amp_thr=3.0, min_cnt=1, vol_ratio=0.9, body_max=1.0)
    cfgs = [
        ('A 阳线日>=1次(近100日)', dict(base, yang_only=True)),
        ('B 阳线日>=1次 + 该日当时在MA20上方', dict(base, yang_only=True, ampday_above_ma20=True)),
        ('C 阳线日>=2次 + 当时在MA20上方', dict(base, yang_only=True, ampday_above_ma20=True, min_cnt=2)),
        ('D 阳线日>=3次 + 当时在MA20上方', dict(base, yang_only=True, ampday_above_ma20=True, min_cnt=3)),
        ('E 阳线日>=1次 + 当时在MA20上方 + 不要求缩量', dict(base, yang_only=True, ampday_above_ma20=True, vol_ratio=99)),
    ]
    for name, cfg in cfgs:
        r = run(cfg)
        if not r:
            print(f'{name}: 无候选'); continue
        print(f"{name}\n  候选{r['n']} 胜率{r['win']:.1f}% 均值{r['avg']:+.3f}% 合计{r['total']:+.1f}%  {dict(r['why'])}")
        print('   分股:', {k:(v[0], round(v[1],2)) for k,v in r['per'].items()})
