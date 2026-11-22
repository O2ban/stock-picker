import json
from eltdx import TdxClient
d=json.load(open('raw2.json'))
need=d['dates'][0]
c=TdxClient()
s=c.minutes.history('sz301557',need)
pts=sorted([[p.time_label,round(float(p.price),2)] for p in s.points])
print(need,len(pts),pts[:2],pts[-2:])
d['buyday_min']={need:pts}
json.dump(d,open('raw2.json','w'))
