import json, sqlite3
from eltdx import TdxClient
CODE='sz301557'
con=sqlite3.connect('/home/ubuntu/kline-trainer/kline-server/data/kline.db')
rows=[r for r in con.execute("select date,open_raw,high_raw,low_raw,close_raw from daily_kline where code=? order by date",(CODE,)).fetchall() if r[3] is not None]
daily={r[0]:{'o':float(r[1]),'h':float(r[2]),'l':float(r[3]),'c':float(r[4])} for r in rows}
alld=sorted(daily)
# 目标卖出日：最近 101 个交易日中，除第一天外（第一天作买入日）
win=alld[-101:]
buy_days=win[:-1]; sell_days=win[1:]
print('buy',buy_days[0],len(buy_days),'sell',sell_days[0],sell_days[-1],len(sell_days))
c=TdxClient()
s=c.bars.get(CODE,period='1m',count=30000,all_pages=True,page_size=800)
bars=s.bars
by={}
for b in bars:
    d=b.time.strftime('%Y-%m-%d')
    by.setdefault(d,[]).append([b.time.strftime('%H:%M'),float(b.open),float(b.high),float(b.low),float(b.close)])
minute={}
miss=[]
for d in sell_days:
    v=sorted(by.get(d,[]))
    if len(v)!=240: miss.append((d,len(v)))
    minute[d]=v
print('minute days',len(minute),'bad',miss)
# 日线需要 MA 的历史，全量输出
json.dump({'code':CODE,'dates':win,'daily':daily,'minute':minute},open('raw2.json','w'))
print('saved', round(len(json.dumps(minute))/1024),'KB')
