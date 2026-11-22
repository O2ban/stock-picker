#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fromLow 门槛多日验证：在本地 36 只 5 分钟数据上复刻日内引擎 findTrigger 全流程，
对比「买点距当日最低点」不同门槛下的胜率 / 净收益 / 时间对齐超额。

口径与 src/intraday.js 一致：
  - 买价 = 触发那根 K 线收盘价，持到当日收盘，扣 FEE=0.26%
  - 距最低点 lift = (买价 - 出手前前缀最低) / 昨收 * 100
  - deepDrop/breakHigh/shape/volume 三段量能全部复刻
  - 只用出手前的分钟点，无未来函数
"""
import os, glob, csv, math, json

FEE = 0.26
POOL = '/home/ubuntu/stock-picker/data/min5_pool/'
BIG = '/home/ubuntu/stock-picker/data/min5/'

# ---- 策略参数（与 strategies/intraday-strong.json 同源）----
WINDOW = (9 * 60 + 35, 10 * 60 + 0)
GAP = (-2.0, 1.5)
VOL = dict(shrinkRatio=0.3, shrinkBurst=3, rebound=2.2, pileMin=3, upMin=2, upMax=8,
           upPct=0.2, dropPct=0.25, look=20)
SHAPE = dict(look=6, maxFlips=2)
MID = dict(requireAboveWater=False, requireAboveMid=True, nearPct=0.8)
WAIT_BARS = 1          # 5 分钟一根，4 分钟的等待折算成 1 根
DEEP_MAX = 3.0
BREAKHIGH = True


def load_csv(path):
    days, order = {}, []
    for row in csv.reader(open(path, encoding='utf-8', errors='ignore')):
        if len(row) < 8:
            continue
        d = row[0].strip()
        try:
            v = (float(row[2]), float(row[3]), float(row[4]), float(row[5]), float(row[6]))
        except ValueError:
            continue
        if d not in days:
            days[d] = []
            order.append(d)
        days[d].append(v)
    return days


def load_ndjson(path):
    days = {}
    for line in open(path, encoding='utf-8', errors='ignore'):
        p = line.strip().split(',')
        if len(p) < 7:
            continue
        d = p[0][:8]
        try:
            v = (float(p[1]), float(p[2]), float(p[3]), float(p[4]), float(p[5]))
        except ValueError:
            continue
        days.setdefault(d, []).append(v)
    return days


def M(v):
    return sum(v) / len(v) if v else float('nan')


def Med(v):
    if not v:
        return float('nan')
    s = sorted(v)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def W(v):
    return sum(1 for x in v if x > 0) / len(v) * 100 if v else float('nan')


def tstat(v):
    if len(v) < 5:
        return 0.0
    m = M(v)
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    return m / (sd / math.sqrt(len(v))) if sd > 0 else 0.0


def shape_ok(price, i, cfg):
    frm = max(1, i - cfg['look'] + 1)
    flips = 0
    last = 0
    bars = 0
    for k in range(frm, i + 1):
        d = price[k] - price[k - 1]
        d = (d > 0) - (d < 0)
        if not d:
            continue
        bars += 1
        if last and d != last:
            flips += 1
        last = d
    return bars >= 2 and flips <= cfg['maxFlips']


def avg_range(arr, a, b):
    return sum(arr[a:b + 1]) / (b - a + 1)


def volume_shape(price, vol, mid, i, v):
    lo_need = v['pileMin'] + v['upMin']
    if i < lo_need:
        return None
    day_avg = sum(vol[:i + 1]) / (i + 1)
    if not day_avg > 0:
        return None
    b_long = max(1, i - v['upMax'] + 1)
    b_short = i - v['upMin'] + 1
    for b in range(max(b_long, 1), b_short + 1):
        top = max(price[b:i + 1])
        if price[i] < top * 0.999:
            continue
        if (price[i] / price[b] - 1) * 100 < v['upPct']:
            continue
        up_avg = avg_range(vol, b, i)
        if not up_avg > 0:
            continue
        for s_len in range(v['pileMin'], v['look'] + 1):
            s2 = b - 1
            s1 = s2 - s_len + 1
            if s1 < 1:
                break
            s_avg = avg_range(vol, s1, s2)
            if not s_avg > 0:
                continue
            if s_avg > day_avg * v['shrinkRatio']:
                continue
            if up_avg / s_avg < v['rebound']:
                continue
            p2 = s1 - 1
            if p2 < 1:
                break
            p1 = max(0, p2 - v['look'] + 1)
            p_avg = avg_range(vol, p1, p2)
            if not p_avg > 0:
                break
            if p_avg / s_avg < v['shrinkBurst']:
                continue
            mid_at = mid[s2]
            if not mid_at > 0:
                break
            if price[s2] < mid_at * (1 - MID['nearPct'] / 100):
                break
            peak = max(price[s1:s2 + 1])
            trough = min(price[s1:s2 + 1])
            if not (peak > 0 and trough > 0):
                break
            drop = (peak - trough) / peak * 100
            rise = (price[i] / trough - 1) * 100
            if drop < v['dropPct'] and rise < v['dropPct']:
                continue
            return f'放量→缩量到1/{(p_avg / s_avg):.1f}({s_len}根)→拉升{i - b + 1}根'
    return None


def find_trigger(price, vol, minute, mid, prev, from_low_max, gain_min, gain_max):
    """返回 dict(i, lift, gain, dip) 或 None。from_low_max=None 表示该条件关闭。"""
    n = len(price)
    pre_low = [0.0] * n
    pre_high = [None] * n
    run_lo, run_hi = float('inf'), None
    for k in range(n):
        run_lo = min(run_lo, price[k])
        pre_low[k] = run_lo
        pre_high[k] = run_hi
        run_hi = price[k] if run_hi is None else max(run_hi, price[k])
    for i in range(n):
        if minute[i] < WINDOW[0]:
            continue
        if minute[i] > WINDOW[1]:
            break
        if not shape_ok(price, i, SHAPE):
            continue
        if not volume_shape(price, vol, mid, i, VOL):
            continue
        for j in range(i, min(i + WAIT_BARS, n - 1) + 1):
            if minute[j] > WINDOW[1]:
                break
            p = price[j]
            if not p >= prev:
                continue
            if MID['requireAboveMid'] and not p >= mid[j]:
                continue
            if not p > price[j - 1]:
                continue
            gain = (p / prev - 1) * 100
            if gain < gain_min - 1e-9 or gain > gain_max + 1e-9:
                continue
            dip = (prev - pre_low[j]) / prev * 100
            if dip > DEEP_MAX + 1e-9:
                continue
            if BREAKHIGH and pre_high[j] is not None and not p > pre_high[j]:
                continue
            lift = (p - pre_low[j]) / prev * 100
            if from_low_max is not None and lift > from_low_max + 1e-9:
                continue
            return dict(i=j, anchor=i, lift=lift, gain=gain, dip=dip)
    return None


# ---- 载入数据 ----
DATA = {}
for fp in sorted(glob.glob(POOL + '*.csv')):
    dd = load_csv(fp)
    if dd:
        DATA[os.path.basename(fp)[:-4]] = ('small', dd)
for fp in sorted(glob.glob(BIG + '*.ndjson')):
    dd = load_ndjson(fp)
    if dd:
        DATA[os.path.basename(fp).split('.')[0]] = ('big', dd)
print(f'有效股票 {len(DATA)} 只（中小盘 {sum(1 for v in DATA.values() if v[0]=="small")}，大盘 {sum(1 for v in DATA.values() if v[0]=="big")}）')

# ---- 时间对齐对照：同日同池同一根 K 线买入持到收盘 ----
CTRL = {}
for code, (pool, days) in DATA.items():
    for d, bars in days.items():
        if len(bars) < 40:
            continue
        cl = bars[-1][3]
        for k in range(0, 8):
            if k >= len(bars):
                break
            px = bars[k][3]
            if px <= 0:
                continue
            CTRL.setdefault((d, pool, k), []).append((cl / px - 1) * 100 - FEE)
CTRL = {k: M(v) for k, v in CTRL.items()}

# ---- 每日上下文预计算 ----
CASES = []   # (code, pool, date, bars, prev, minute, mid, ctl_list)
for code, (pool, days) in DATA.items():
    ds = sorted(days)
    for idx, d in enumerate(ds):
        bars = days[d]
        if len(bars) < 40 or idx < 6:
            continue
        prev = days[ds[idx - 1]][-1][3]
        if prev <= 0:
            continue
        gap = (bars[0][0] / prev - 1) * 100
        if gap < GAP[0] - 1e-9 or gap > GAP[1] + 1e-9:
            continue
        price = [b[3] for b in bars]
        vol = [b[4] for b in bars]
        minute = []
        for b_i in range(len(bars)):
            # 5 分钟 K 线按结束时刻标注：第 0 根 = 0935
            minute.append(9 * 60 + 35 + 5 * b_i)
        mid = []
        hi, lo = -float('inf'), float('inf')
        for p in price:
            hi = max(hi, p)
            lo = min(lo, p)
            mid.append((hi + lo) / 2)
        CTRL_row = [CTRL.get((d, pool, k)) for k in range(len(bars))]
        CASES.append(dict(code=code, pool=pool, date=d, bars=bars, prev=prev,
                          price=price, vol=vol, minute=minute, mid=mid, ctl=CTRL_row))
print(f'入池交易样本 {len(CASES)} 个交易日（已过开盘幅度 {-GAP[0]}~+{GAP[1]} 点）\n')


def run(from_low_max, gmin=1.0, gmax=3.0, tag=''):
    rows = []
    for c in CASES:
        t = find_trigger(c['price'], c['vol'], c['minute'], c['mid'], c['prev'],
                         from_low_max, gmin, gmax)
        if not t:
            continue
        buy = c['price'][t['i']]
        cl = c['bars'][-1][3]
        if buy <= 0 or cl <= 0:
            continue
        ret = (cl / buy - 1) * 100 - FEE
        ctl = c['ctl'][t['i']]
        rows.append(dict(code=c['code'], pool=c['pool'], date=c['date'], k=t['i'],
                         lift=t['lift'], gain=t['gain'], dip=t['dip'],
                         ret=ret, ex=(ret - ctl) if ctl is not None else None))
    return rows


def show(rows, tag):
    if not rows:
        print(f'  {tag:34s} 无样本')
        return
    r = [x['ret'] for x in rows]
    e = [x['ex'] for x in rows if x['ex'] is not None]
    print(f'  {tag:34s} n={len(rows):5d} 胜 {W(r):5.1f}% 净 {M(r):+7.3f}% 中位 {Med(r):+7.3f}%'
          f' 赚均 {M([x for x in r if x>0]) if any(x>0 for x in r) else float("nan"):+6.2f}'
          f' 亏均 {M([x for x in r if x<=0]) if any(x<=0 for x in r) else float("nan"):+6.2f}'
          f' | 超额 {M(e):+7.3f}% (t={tstat(e):5.2f})')


VARIANTS = [
    (None, 1.0, 3.0, 'fromLow=off（原口径）'),
    (3.0, 1.0, 3.0, 'fromLow<=3.0 点'),
    (2.5, 1.0, 3.0, 'fromLow<=2.5 点（当前线上）'),
    (2.0, 1.0, 3.0, 'fromLow<=2.0 点'),
    (1.5, 1.0, 3.0, 'fromLow<=1.5 点'),
    (1.0, 1.0, 3.0, 'fromLow<=1.0 点'),
]

print('===== 一、fromLow 门槛单变量对比（全部通过全流程筛选的信号）=====')
ALL = {}
for fm, gmin, gmax, tag in VARIANTS:
    rows = run(fm, gmin, gmax)
    ALL[tag] = rows
    show(rows, tag)

print('\n===== 二、fromLow × 买点涨幅 组合 =====')
for fm in (None, 2.5, 2.0, 1.5):
    for (gmin, gmax) in ((1.0, 2.0), (1.5, 2.5), (1.5, 2.0), (2.0, 3.0)):
        rows = run(fm, gmin, gmax)
        show(rows, f'fromLow={fm if fm is not None else "off"} × 涨幅{gmin}~{gmax}')

print('\n===== 三、当前线上口径（2.5 点）按实际 lift 分档 =====')
rows = ALL['fromLow<=2.5 点（当前线上）']
buckets = {'0~0.5': [], '0.5~1.0': [], '1.0~1.5': [], '1.5~2.0': [], '2.0~2.5': []}
for x in rows:
    L = x['lift']
    b = '0~0.5' if L < 0.5 else ('0.5~1.0' if L < 1.0 else ('1.0~1.5' if L < 1.5 else ('1.5~2.0' if L < 2.0 else '2.0~2.5')))
    buckets[b].append(x)
for b in buckets:
    show(buckets[b], f'lift {b} 点')

print('\n===== 四、当前线上口径分年 =====')
byy = {}
for x in rows:
    byy.setdefault(x['date'][:4], []).append(x)
for y in sorted(byy):
    show(byy[y], f'{y} 年')

print('\n===== 五、当前线上口径分池 =====')
for pool in ('small', 'big'):
    show([x for x in rows if x['pool'] == pool], f'{"中小盘" if pool=="small" else "大盘股"}')

print('\n===== 六、当前线上口径按触发根（09:35 起每根 5 分钟）=====')
byk = {}
for x in rows:
    byk.setdefault(x['k'], []).append(x)
for k in sorted(byk):
    mm = 9 * 60 + 35 + 5 * k
    show(byk[k], f'{mm // 60:02d}:{mm % 60:02d}')

print('\n===== 七、出场方式敏感性（当前 2.5 点口径）=====')
# 次日开盘卖出 vs 当日收盘
nxt = []
for c in CASES:
    pass
for x in rows:
    pass
print('  （见下方统一说明：本脚本净收益统一按「买点→当日收盘」计，与收盘复核口径一致）')
