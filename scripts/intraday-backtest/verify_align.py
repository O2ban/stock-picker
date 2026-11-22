import sqlite3, os
DB='/home/ubuntu/kline-trainer/kline-server/data/kline.db'
MIN5='/home/ubuntu/stock-picker/data/min5'
CODES=['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']
c=sqlite3.connect(DB)
for code in CODES:
    rows=c.execute("select date,close_qfq from daily_kline where code=? order by date",(code,)).fetchall()
    dm={d[:10].replace('-',''):cl for d,cl in rows if cl}
    path=os.path.join(MIN5,code+'.ndjson')
    if not os.path.exists(path): continue
    last={}
    with open(path) as f:
        for line in f:
            p=line.strip().split(',')
            if len(p)<6: continue
            t=p[0]
            if len(t)<12: continue
            last[t[:8]]=float(p[4])
    days=sorted(last.keys())[-40:]
    diffs=[]
    for d in days:
        if d in dm and dm[d]>0:
            diffs.append((d,dm[d],last[d],(last[d]/dm[d]-1)*100))
    if not diffs:
        print(code,'无重叠'); continue
    ds=sorted(x[3] for x in diffs)
    print('%s 重叠%d天 差值中位%.3f%% 最小%.3f%% 最大%.3f%% 最近一天 %s 日线%.4f 5min%.4f'%(
        code,len(diffs),ds[len(ds)//2],ds[0],ds[-1],diffs[-1][0],diffs[-1][1],diffs[-1][2]))
c.close()
