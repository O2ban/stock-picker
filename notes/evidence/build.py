import json, statistics
from functools import reduce
d=json.load(open('raw.json'))
dates=d['dates']; daily=d['daily']; mins=d['min']
FEE=0.26
R=lambda x: round(x+1e-9,2)

trades=[]
for i in range(len(dates)-1):
    T=dates[i]; T1=dates[i+1]
    bp=R(daily[T]['c'])
    pc=R(mins[T1]['prev_close'])
    pr=[R(p[1]) for p in mins[T1]['points']]
    tl=[p[0] for p in mins[T1]['points']]
    thr=round(pc*1.01,4)
    hit=None; ep=None; et=None; kind=None; slot=None
    for j,p in enumerate(pr):
        if p>=thr: hit=j; break
    if hit is None:
        ep=pr[-1]; et=tl[-1]; kind='NOHIT_CLOSE'
    else:
        for k in range(hit+1,len(pr)):
            if pr[k]<pr[k-1]: ep=pr[k]; et=tl[k]; slot=k; break
        if ep is None: ep=pr[-1]; et=tl[-1]; kind='HOLD'
        else: kind='TURN'
    prevT=R(daily[dates[i-1]]['c']) if i>0 else None
    hpr=(R(daily[T]['h'])/prevT-1)*100 if prevT else None
    gross=(ep/bp-1)*100
    trades.append({
      'n':i+1,'T':T,'T1':T1,'buy':bp,'sell':ep,'kind':kind,'et':et,
      'thr':thr,'hit_t':tl[hit] if hit is not None else None,
      'hit_p':pr[hit] if hit is not None else None,
      'gross':round(gross,4),'net':round(gross-FEE,4),
      'hpr':round(hpr,4) if hpr is not None else None,
      'open':R(daily[T1]['o']),'close':R(daily[T1]['c']),
      'hi':R(daily[T1]['h']),'lo':R(daily[T1]['l']),
      'p0':pc,
    })

# 逐笔分钟路径（用于页面核对）
paths={}
for t in trades:
    pts=mins[t['T1']]['points']
    paths[t['T']]=[[p[0],round(p[1],2)] for p in pts]

json.dump({'trades':trades,'paths':paths,'fee':FEE,'code':d['code']},open('data.json','w'))
print('trades',len(trades),'size',round(len(json.dumps(paths))/1024),'KB')
