import sqlite3, os, random
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
    days=sorted(last.keys())
    # 按年份抽样，每年取3天
    byyear={}
    for d in days:
        y=d[:4]
        if d in dm and dm[d]>0: byyear.setdefault(y,[]).append(d)
    print(code, end='  ')
    out=[]
    for y in sorted(byyear):
        samp=random.sample(byyear[y], min(3,len(byyear[y])))
        ds=[(last[d]/dm[d]-1)*100 for d in samp]
        out.append('%s:%.2f~%.2f'%(y,min(ds),max(ds)))
    print(' '.join(out))
c.close()
