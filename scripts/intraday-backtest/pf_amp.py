import sqlite3, os, sys
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
        d['yang'] = d['c'] > d['o']
    if out: out[0]['amp']=out[0]['body']=0; out[0]['yang']=False
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
    L = cfg['amp_win']            # 平均振幅的统计窗口，100
    closes = [x['c'] for x in days]
    if i+1 < L+1: return None
    m5 = ma(closes, i, 5); m20 = ma(closes, i, 20)
    if m5 is None or m20 is None: return None
    # 1) 收盘在 MA5 与 MA20 上方
    if not (d['c'] > m5 and d['c'] > m20): return None
    # 2) 100 日平均振幅 > 门槛
    def ma_amp(k):
        if k+1 < L: return None
        return sum(x['amp'] for x in days[k-L+1:k+1])/L
    a_now = ma_amp(i)
    if a_now is None or a_now <= cfg['amp_avg_thr']: return None
    # 3) 最近几天这个平均值也都在门槛之上（持续性，避免刚抬头）
    for k in range(i-cfg['sustain']+1, i+1):
        a = ma_amp(k)
        if a is None or a <= cfg['amp_avg_thr']: return None
    # 4) 100 日内振幅 >3% 的那些天，阳线占多数
    win = days[i-L+1:i+1]
    big = [x for x in win if x['amp'] > cfg['amp_thr']]
    if len(big) < cfg.get('min_big', 5): return None
    yang_ratio = sum(1 for x in big if x['yang'])/len(big)
    if yang_ratio < cfg['yang_ratio']: return None
    # 5) 今日缩量
    if i >= 5 and cfg.get('vol_ratio', 99) < 99:
        v5 = sum(x['v'] for x in days[i-5:i])/5
        if v5 > 0 and d['v'] > cfg['vol_ratio']*v5: return None
    # 6) 今日实体小
    if abs(d['body']) > cfg['body_max']: return None
    return True

def run(cfg, tp=3.0, sl=1.0, verbose=False):
    res = []; per = {}
    for code in CODES:
        days = load_daily(code); m5 = load_min5(code)
        if not days or not m5: continue
        n_code = 0; tot_code = 0.0; win_code = 0
        for i in range(0, len(days)-1):
            if not check(days, i, cfg): continue
            nb = m5.get(dkey(days[i+1]['date']))
            if not nb: continue
            r, why = simulate(nb, days[i]['c'], tp, sl)
            res.append((code, days[i]['date'], r, why))
            n_code += 1; tot_code += r - FEE
            if r - FEE > 0: win_code += 1
        if n_code: per[code] = (n_code, tot_code/n_code, win_code/n_code*100)
    if not res: return None
    n = len(res); tot = sum(x[2]-FEE for x in res)
    win = sum(1 for x in res if x[2]-FEE > 0)
    return dict(n=n, avg=tot/n, win=win/n*100, total=tot, per=per,
                why=Counter(x[3] for x in res), res=res)

if __name__ == '__main__':
    base = dict(amp_win=100, amp_avg_thr=3.0, amp_thr=3.0, sustain=5,
                yang_ratio=0.5, min_big=5, vol_ratio=0.9, body_max=1.0)
    cfgs = [
        ('A 100日均振幅>3 + 近5日均>3 + 大振幅日阳线过半 + 缩量 + 小实体', base),
        ('B 同上但阳线占比>=60%', dict(base, yang_ratio=0.6)),
        ('C 同上但阳线占比>=70%', dict(base, yang_ratio=0.7)),
        ('D 同上但阳线占比>=50%、不要求缩量', dict(base, vol_ratio=99)),
        ('E 同上A，但平均振幅门槛>4%', dict(base, amp_avg_thr=4.0)),
    ]
    for name, cfg in cfgs:
        r = run(cfg)
        if not r:
            print(f'{name}: 无候选\n'); continue
        print(f"{name}\n  候选{r['n']} 胜率{r['win']:.1f}% 均值{r['avg']:+.3f}% 合计{r['total']:+.1f}%")
        print(f"  出场 {dict(r['why'])}")
        print('  分股:', {k:(v[0], round(v[1],2), round(v[2],0)) for k,v in r['per'].items()})
        print()
