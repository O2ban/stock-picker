"""sh603186 华正新材 按 filtered 方案回测。
沿用 bt.py 口径：收盘买、次日盘中触价卖、跳空开盘卖、全天未触及收盘卖、fee 双边。
区间受分钟数据限制：仅买入日次日有分钟数据才参与。
"""
import json, statistics
HERE = '/home/ubuntu/stock-picker/notes/evidence/v2'
d = json.load(open(f'{HERE}/raw603186.json'))
daily = d['daily']; minute = d['minute']
FEE = 0.083
R = lambda x: round(x + 1e-9, 2)
alld = sorted(daily)
pos = {x: i for i, x in enumerate(alld)}
closes = [daily[x]['c'] for x in alld]

def ma(day, n):
    i = pos[day]
    if i + 1 < n: return None
    return sum(closes[i+1-n:i+1]) / n

# 候选买入日 = 有分钟数据的日期中，次日也有分钟数据的（出场需要次日分钟）
mdays = sorted(minute)
trades = []; skipped = []
for T in mdays[:-1]:
    T1 = mdays[mdays.index(T) + 1]
    bp = R(daily[T]['c'])
    p0 = bp
    thr = round(p0 * 1.01, 4)
    # 过滤1：高昨比
    prevT = R(daily[alld[pos[T]-1]]['c']) if pos[T] > 0 else None
    hpr = (R(daily[T]['h']) / prevT - 1) * 100 if prevT else None
    # 过滤2：T 收盘同时跌破 MA5 与 MA20
    m5 = ma(T, 5); m20 = ma(T, 20)
    cqf = closes[pos[T]]
    belowBoth = (m5 is not None and m20 is not None and cqf < m5 and cqf < m20)

    bars = minute[T1]
    k = None
    for j, b in enumerate(bars):
        if b[2] >= thr: k = j; break
    if k is None:
        ep = R(bars[-1][4]); et = '15:00'; kind = 'NOHIT_CLOSE'; hit_t = None; hit_p = None
    else:
        o = bars[k][1]; h = bars[k][2]
        ep = R(max(o, thr))
        et = bars[k][0]; kind = 'OPEN_GAP' if (k == 0 and o >= thr) else 'TARGET'
        hit_t = bars[k][0]; hit_p = R(h)
    gross = (ep / bp - 1) * 100
    rec = {'n': pos[T]+1, 'T': T, 'T1': T1, 'buy': bp, 'sell': ep, 'kind': kind, 'et': et,
           'thr': thr, 'hit_t': hit_t, 'hit_p': hit_p, 'gross': round(gross, 4),
           'net': round(gross - FEE, 4), 'hpr': round(hpr, 4) if hpr is not None else None,
           'ma5': round(m5, 4) if m5 else None, 'ma20': round(m20, 4) if m20 else None,
           'below_both': belowBoth, 'p0': p0}
    gate = []
    if hpr is None: gate.append('NO_PREVDATA')
    elif hpr < 1: gate.append('HPR_LT1')
    if belowBoth: gate.append('BELOW_MA')
    rec['gates'] = gate
    (skipped if gate else trades).append(rec)

def stat(ts):
    if not ts: return {'n': 0}
    ns = [t['net'] for t in ts]
    cum = 1.0
    for x in ns: cum *= (1 + x / 100)
    wins = [x for x in ns if x > 0]; losses = [x for x in ns if x <= 0]
    win = 100 * len(wins) / len(ns)
    avgWin = sum(wins) / len(wins) if wins else 0
    avgLoss = sum(losses) / len(losses) if losses else 0
    return {'n': len(ns), 'mean': round(sum(ns)/len(ns), 4),
            'med': round(statistics.median(ns), 4), 'win': round(win, 2),
            'cum': round((cum - 1) * 100, 4),
            'avgWin': round(avgWin, 4), 'avgLoss': round(avgLoss, 4)}

allt = sorted(trades + skipped, key=lambda x: x['n'])

# 100 天高昨比统计（与 301557 口径一致：买入日候选区间内 hpr 平均值 & >1% 占比）
hprs = [t['hpr'] for t in allt if t['hpr'] is not None]
hprAvg100 = round(sum(hprs) / len(hprs), 2) if hprs else None
hprGt1 = round(100 * sum(1 for h in hprs if h > 1) / len(hprs)) if hprs else None

print('=== sh603186 华正新材 ===')
print('买入日区间', mdays[0], '~', mdays[-2], ' 卖出日至', mdays[-1])
print('分钟数据日数', len(mdays))
print('全候选(all)     ', stat(allt))
print('filtered(过滤后) ', stat(trades))
print('TARGET           ', stat([t for t in trades if t['kind'] == 'TARGET']))
print('OPEN_GAP         ', stat([t for t in trades if t['kind'] == 'OPEN_GAP']))
print('NOHIT_CLOSE      ', stat([t for t in trades if t['kind'] == 'NOHIT_CLOSE']))
print('被挡笔数', len(skipped), ' 挡因分布:',
      {g: sum(1 for t in skipped if g in t['gates']) for g in ('HPR_LT1', 'BELOW_MA')})
json.dump({'trades': trades, 'skipped': skipped, 'all': allt, 'fee': FEE,
           'code': 'sh603186', 'name': '华正新材'},
          open(f'{HERE}/bt603186.json', 'w'), ensure_ascii=False)
print('saved bt603186.json')
