import json
d=json.load(open('raw2.json')); b=json.load(open('bt.json'))
minute=d['minute']; dates=d['dates']; daily=d['daily']; bmin=d.get('buyday_min',{})
slots=[x[0] for x in minute[dates[1]]]
days={}; highs={}; lows={}; opens={}
need=set()
for t in b['all']: need.add(t['T']); need.add(t['T1'])
for dt in sorted(need):
    if dt in minute:
        opens[dt]=[round(x[1],2) for x in minute[dt]]
        days[dt]=[round(x[4],2) for x in minute[dt]]
        highs[dt]=[round(x[2],2) for x in minute[dt]]
        lows[dt]=[round(x[3],2) for x in minute[dt]]
    elif dt in bmin:
        p=[x[1] for x in bmin[dt]]
        assert len(p)==len(slots), (dt,len(p))
        days[dt]=p; highs[dt]=list(p); lows[dt]=list(p); opens[dt]=list(p)
    else:
        raise SystemExit('missing '+dt)
assert days[dates[0]][-1]==round(daily[dates[0]]['c'],2), (days[dates[0]][-1], daily[dates[0]]['c'])
def slim(t):
    o={k:t[k] for k in ('n','T','T1','buy','sell','kind','et','thr','hit_t','hit_p','gross','net','hpr','ma5','ma20','p0','open','close','hi','lo','gates')}
    o['below_both']=t['below_both']
    return o
pc={}
for i,dt in enumerate(dates):
    pc[dt]=round(daily[dates[i-1]]['c'],2) if i>0 else None
out={'code':'301557','name':'常友科技','fee':b['fee'],'slots':slots,
     'days':days,'highs':highs,'lows':lows,'opens':opens,'pc':pc,
     'trades':[slim(t) for t in b['trades']],
     'skipped':[slim(t) for t in b['skipped']],
     'all':[slim(t) for t in b['all']]}
open('fe.json','w').write(json.dumps(out,separators=(',',':'),ensure_ascii=False))
print('bytes',len(open('fe.json').read().encode()),'trades',len(out['trades']),'skipped',len(out['skipped']),'days',len(days),'slots',len(slots))
print('buyday last',days[dates[0]][-1],'daily c',round(daily[dates[0]]['c'],2))
