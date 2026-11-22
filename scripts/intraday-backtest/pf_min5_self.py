#!/usr/bin/env python3
# 纯 min5 自洽回测：日线由5分钟聚合，指标与买卖全用同一套价格
# 条件：近3日各自振幅>3% 且 近3日收盘均在MA5、MA20上方 且 今日实体小(可调)
# 买入：今日收盘价。次日5分钟逐根：先触+3%止盈 / 先触-1%止损 / 跳空按开盘 / 都没触收盘平
import os, statistics

MIN5 = '/home/ubuntu/stock-picker/data/min5'
CODES = ['sh600000','sh600519','sh601318','sz000001','sz000858','sz002594','sz300059','sz300750']
FEE = 0.26  # 双边成本 %
TP, SL = 3.0, 1.0
BODY_MAX = 1.0
AMP_THR = 3.0

def load(code):
    f = os.path.join(MIN5, code + '.ndjson')
    days = {}
    order = []
    bars = []  # (day, o,h,l,c, vol)
    with open(f) as fh:
        for line in fh:
            p = line.strip().split(',')
            if len(p) < 7: continue
            d = p[0][:8]; o,h,l,c,v = float(p[1]),float(p[2]),float(p[3]),float(p[4]),float(p[5])
            bars.append((d,o,h,l,c,v))
            if d not in days:
                days[d] = [o,h,l,c,v]; order.append(d)
            else:
                x = days[d]
                x[1] = max(x[1],h); x[2] = min(x[2],l); x[3] = c; x[4] += v
    return order, days, bars

def ma(vals, n):
    out = [None]*len(vals)
    s = 0.0
    for i,v in enumerate(vals):
        s += v
        if i >= n: s -= vals[i-n]
        if i >= n-1: out[i] = s/n
    return out

def simulate(future_bars, buy):
    # future_bars: 次日 (d,o,h,l,c,v) 列表
    if not future_bars: return None
    tp_p = buy*(1+TP/100); sl_p = buy*(1-SL/100)
    d,o,h,l,c,v = future_bars[0]
    # 跳空
    if o <= sl_p: return ('S跳空', (o/buy-1)*100)
    if o >= tp_p: return ('T跳空', (o/buy-1)*100)
    for (d2,o2,h2,l2,c2,v2) in future_bars:
        hit_s = l2 <= sl_p
        hit_t = h2 >= tp_p
        if hit_s and hit_t: return ('S止损', -SL)      # 同根两头都碰 按先亏
        if hit_s: return ('S止损', -SL)
        if hit_t: return ('T止盈', TP)
    return ('收盘', (future_bars[-1][4]/buy-1)*100)

def run(name, body_max=BODY_MAX, need_shrink=False, min_days=3):
    res = []
    per_day = {}
    for code in CODES:
        order, days, bars = load(code)
        idx = {d:i for i,d in enumerate(order)}
        closes = [days[d][3] for d in order]
        vols = [days[d][4] for d in order]
        m5 = ma(closes,5); m20 = ma(closes,20)
        # 每日bar索引区间
        byday = {}
        for i,(d,o,h,l,c,v) in enumerate(bars):
            byday.setdefault(d,[]).append(i)
        for i in range(21, len(order)-1):
            d = order[i]
            o,h,l,c,v = days[d]
            prev_c = closes[i-1]
            if prev_c <= 0: continue
            amp = (h-l)/prev_c*100
            # 近 min_days 日条件
            ok = True
            for k in range(min_days):
                j = i-k
                if j < 21: ok = False; break
                oj,hj,lj,cj,vj = days[order[j]]
                pc = closes[j-1]
                if pc <= 0: ok = False; break
                if (hj-lj)/pc*100 <= AMP_THR: ok = False; break
                if m5[j] is None or m20[j] is None: ok = False; break
                if cj <= m5[j] or cj <= m20[j]: ok = False; break
            if not ok: continue
            # 今日实体小
            if abs(c-o)/prev_c*100 > body_max: continue
            # 今日缩量
            if need_shrink:
                if i < 6: continue
                avg5 = sum(vols[i-5:i])/5
                if avg5 <= 0 or v >= avg5*0.9: continue
            # 次日
            nd = order[i+1]
            fb = [bars[x] for x in byday[nd]]
            r = simulate(fb, c)
            if r is None: continue
            res.append((code, d, r[0], r[1]))
            per_day[d] = per_day.get(d,0)+1
    if not res:
        print('%s: 无候选' % name); return
    n = len(res)
    wins = sum(1 for x in res if x[3] > 0)
    avg = sum(x[3] for x in res)/n
    net = avg - FEE
    total = sum(x[3] for x in res) - FEE*n
    cnt = {}
    for x in res: cnt[x[2]] = cnt.get(x[2],0)+1
    print('=== %s ===' % name)
    print('  候选=%d  胜率=%.1f%%  均值=%+.3f%%  扣费均值=%+.3f%%  合计=%+.1f%%' % (n, wins/n*100, avg, net, total))
    print('  退出构成: ' + '  '.join('%s=%d(%.1f%%)' % (k,v,v/n*100) for k,v in sorted(cnt.items(), key=lambda z:-z[1])))
    pd = sorted(per_day.values())
    if pd:
        print('  每日命中: 中位=%d  均值=%.1f  最大=%d  有信号天数=%d/%d' % (
            pd[len(pd)//2], sum(pd)/len(pd), max(pd), len(per_day), len(order)))
    # 分股
    byc = {}
    for code,d,how,r in res: byc.setdefault(code,[]).append(r)
    print('  分股: ' + '  '.join('%s n=%d 均%+.2f%%' % (c, len(v), sum(v)/len(v)) for c,v in sorted(byc.items())))
    print()

if __name__ == '__main__':
    run('A 近3日均振幅>3 + 3日站5/20均线 + 今日实体<1%')
    run('B A + 今日缩量(<5日均量9折)', need_shrink=True)
    run('C 仅今日振幅>3 + 站均线 + 实体<1%', min_days=1)
    run('D 近2日均振幅>3 + 站均线 + 实体<1%', min_days=2)
    run('E A + 实体<2%', body_max=2.0)
