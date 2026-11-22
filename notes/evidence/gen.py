import json, sqlite3
from eltdx import TdxClient

CODE='sz301557'
con=sqlite3.connect('/home/ubuntu/kline-trainer/kline-server/data/kline.db')
rows=[r for r in con.execute("select date,open_raw,high_raw,low_raw,close_raw from daily_kline where code=? order by date",(CODE,)).fetchall() if r[3] is not None]
rows=rows[-101:]
dates=[r[0] for r in rows]
daily={r[0]:{'o':float(r[1]),'h':float(r[2]),'l':float(r[3]),'c':float(r[4])} for r in rows}
c=TdxClient(); minu={}
for dt in dates:
    s=c.minutes.history(CODE,dt)
    assert s and len(s.points)==240, dt
    minu[dt]={'prev_close':float(s.prev_close),'points':[[p.time_label,float(p.price)] for p in s.points]}
json.dump({'code':CODE,'dates':dates,'daily':daily,'min':minu},open('raw.json','w'))
print('ok', len(dates), len(minu))
