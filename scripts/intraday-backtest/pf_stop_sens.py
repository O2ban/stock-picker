#!/usr/bin/env python3
# 止损敏感性：同样选股条件，改止损/止盈组合
import os, itertools
MIN5 = '/home/ubuntu/stock-picker/data/min5'
CODES = ['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']
FEE = 0.26
AMP_THR = 3.0

def load(code):
    days = {}; order = []; bars = []
    with open(os.path.join(MIN5, code + '.ndjson')) as fh:
        for line in fh:
            p = line.strip().split(',')
            if len(p) < 7: continue
            d = p[0][:8]; o,h,l,c,v = float(p[1]),float(p[2]),float(p[3]),float(p[4]),float(p[5])
            bars.append((d,o,h,l,c,v))
            if d not in days:
                days[d] = [o,h,l,c,v]; order.append(d)
            else:
                x = days[d]; x[1]=max(x[1],h); x[2]=min(x[2],l); x[3]=c; x[4]+=v
    return order, days, bars

def ma(vals,n):
    out=[None]*len(vals); s=0.0
    for i,v in enumerate(vals):
        s+=v
        if i>=n: s-=vals[i-n]
        if i>=n-1: out[i]=s/n
    return out

def sim(fb, buy, tp, sl):
    tp_p=buy*(1+tp/100); sl_p=buy*(1-sl/100)
    d,o,h,l,c,v = fb[0]
    if o<=sl_p: return (o/buy-1)*100
    if o>=tp_p: return (o/buy-1)*100
    for (dd,o2,h2,l2,c2,v2) in fb:
        hs = l2<=sl_p; ht = h2>=tp_p
        if hs: return -sl
        if ht: return tp
    return (fb[-1][4]/buy-1)*100

def collect(body_max=1.0, need_shrink=False, min_days=3):
    """返回 [(code,date,buy,future_bars)]"""
    out=[]
    for code in CODES:
        order, days, bars = load(code)
        closes=[days[d][3] for d in order]; vols=[days[d][4] for d in order]
        m5=ma(closes,5); m20=ma(closes,20)
        byday={}
        for i,(d,o,h,l,c,v) in enumerate(bars): byday.setdefault(d,[]).append(i)
        for i in range(21,len(order)-1):
            d=order[i]; o,h,l,c,v=days[d]; pc=closes[i-1]
            if pc<=0: continue
            ok=True
            for k in range(min_days):
                j=i-k
                if j<21: ok=False; break
                oj,hj,lj,cj,vj=days[order[j]]; pj=closes[j-1]
                if pj<=0 or (hj-lj)/pj*100<=AMP_THR: ok=False; break
                if m5[j] is None or m20[j] is None or cj<=m5[j] or cj<=m20[j]: ok=False; break
            if not ok: continue
            if abs(c-o)/pc*100>body_max: continue
            if need_shrink:
                if i<6: continue
                if vols[i-5:i] and v>=sum(vols[i-5:i])/5*0.9: continue
            nd=order[i+1]
            out.append((code,d,c,[bars[x] for x in byday[nd]]))
    return out

def report(tag, r, base):
    if not base: print('%s: 无候选'%tag); return
    fees=[sim(fb,buy,tp,sl) for _,_,buy,fb in base for tp,sl in [r]]
    n=len(fees); avg=sum(fees)/n; net=avg-FEE
    wins=sum(1 for x in fees if x>0)
    print('  %-16s n=%3d 胜率=%4.1f%% 均值=%+.3f%% 扣费=%+.3f%% 合计=%+6.1f%%' % (tag,n,wins/n*100,avg,net,net*n))

if __name__=='__main__':
    for tag, kw in [('A无缩量', dict()), ('B缩量', dict(need_shrink=True))]:
        base = collect(**kw)
        print('=== 选股：%s （候选 %d）===' % (tag, len(base)))
        for tp,sl in [(3,1),(3,1.5),(3,2),(3,2.5),(3,3),(4,2),(5,3),(6,3),(6,4),(8,4)]:
            report('tp%d/sl%d'%(tp,sl), (tp,sl), base)
        print()
