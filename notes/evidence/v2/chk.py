import json
from eltdx import TdxClient
d=json.load(open('raw2.json')); minute=d['minute']
c=TdxClient()
for dt in ['2026-06-26','2026-08-14','2026-11-20']:
    s=c.minutes.history('sz301557',dt)
    hp=[round(float(p.price),2) for p in s.points]
    bp=[round(x[4],2) for x in minute[dt]]
    bp_hi=[round(x[2],2) for x in minute[dt]]
    diff=[i for i in range(240) if hp[i]!=bp[i]]
    print(dt,'len',len(hp),len(bp),'price diffs',len(diff), diff[:5])
    if diff:
        i=diff[0]; print('  hist',hp[i],'bar_close',bp[i],'bar_hi',bp_hi[i])
