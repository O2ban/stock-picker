# -*- coding: utf-8 -*-
"""2026-11-12 一分钟口径回测（intraday-strong）。

两段式：
  fetch —— 为已落盘的样本股补抓「2026-11-11 昨收 / 11-12 全天 / 11-13 开盘」，增量写缓存
  run   —— 按 src/intraday.js 的 findTrigger 一比一复现买点，算当日收盘与次日开盘两种出场

口径纪律：
  · 决策只用当根及之前的分钟数据；前高 preHigh 不含当根，前低 preLow 含当根；
  · 买入价 = 触发那根一分钟的收盘价；
  · 费用双边合计 0.26%；
  · 剔除样本单独统计（数据不足、无昨收、无次日开盘）。
"""
import json, os, sys, time, urllib.request, glob, collections

DAY = '2026-11-12'
PREV = '2026-11-11'
NEXT = '2026-11-13'
ROOT = os.path.dirname(os.path.abspath(__file__))
WS = os.path.abspath(os.path.join(ROOT, '..', '..'))
DATA = os.path.join(WS, 'data', 'intraday-min', DAY)
CACHE = os.path.join(DATA, '_ctx.json')
FEE = 0.26
UA = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/'}


def fetch_one(symbol):
    url = ('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
           '?symbol=%s&scale=1&ma=no&datalen=1970' % symbol)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def do_fetch(limit):
    codes = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(DATA, '*.json'))
                   if not os.path.basename(p).startswith('_'))
    cache = {}
    if os.path.exists(CACHE):
        cache = json.load(open(CACHE))
    todo = [c for c in codes if c not in cache]
    print('codes', len(codes), 'cached', len(cache), 'todo', len(todo), flush=True)
    cnt = collections.Counter()
    t0 = time.time()
    for i, c in enumerate(todo[:limit], 1):
        try:
            rows = fetch_one(c)
            prev = [x for x in rows if x.get('day', '').startswith(PREV)]
            day = [x for x in rows if x.get('day', '').startswith(DAY)]
            nxt = [x for x in rows if x.get('day', '').startswith(NEXT)]
            if not day:
                cnt['no_day'] += 1
            elif not prev:
                cnt['no_prev'] += 1
            else:
                cache[c] = {
                    'prevClose': float(prev[-1]['close']),
                    'prevDayPct': None,  # 策略里 prevDay 已关闭，不取
                    'day': [[x['day'][11:16], float(x['open']), float(x['high']),
                             float(x['low']), float(x['close']), float(x['volume'])] for x in day],
                    'nextOpen': float(nxt[0]['open']) if nxt else None,
                    'nextClose': float(nxt[-1]['close']) if nxt else None,
                }
                cnt['ok'] += 1
        except Exception:
            cnt['bad'] += 1
        if i % 25 == 0:
            print('fetch', i, dict(cnt), 'sec', round(time.time() - t0, 1), flush=True)
            json.dump(cache, open(CACHE + '.part', 'w'))
            os.replace(CACHE + '.part', CACHE)
        time.sleep(0.06)
    json.dump(cache, open(CACHE + '.part', 'w'))
    os.replace(CACHE + '.part', CACHE)
    print('fetch_done', len(todo[:limit]), dict(cnt), 'cached_total', len(cache),
          'sec', round(time.time() - t0, 1), flush=True)


# ---------------- 引擎复现 ----------------

def shape_ok(price, i, look, max_flips):
    frm = max(1, i - look + 1)
    flips = 0
    last = 0
    bars = 0
    for k in range(frm, i + 1):
        d = (price[k] > price[k - 1]) - (price[k] < price[k - 1])
        if not d:
            continue
        bars += 1
        if last and d != last:
            flips += 1
        last = d
    return bars >= 2 and flips <= max_flips


def avg_range(arr, a, b):
    if b < a:
        return None
    return sum(arr[a:b + 1]) / (b - a + 1)


def vol_base(vol, i):
    return sum(vol[:i + 1]) / (i + 1)


def volume_shape(price, vol, mid, i, v, near_pct):
    lo = max(1, i - v['look'] - v['upMax'])
    if i < v['pileMin'] + v['upMin']:
        return None
    day_avg = vol_base(vol, i)
    if not day_avg > 0:
        return None
    b_long = max(1, i - v['upMax'] + 1)
    b_short = i - v['upMin'] + 1
    for b in range(b_long, b_short + 1):
        top = max(price[b:i + 1])
        if price[i] < top * 0.999:
            continue
        if (price[i] / price[b] - 1) * 100 < v['upPct']:
            continue
        up_len = i - b + 1
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
            pre_found = False
            pre_avg = 0.0
            pre_len = 0
            for p_len in range(v['prePileMin'], min(v['look'], p2 + 1) + 1):
                p1 = p2 - p_len + 1
                p_avg = avg_range(vol, p1, p2)
                if not p_avg > 0 or p_avg / s_avg < v['shrinkBurst']:
                    continue
                pre_found = True
                pre_avg = p_avg
                pre_len = p_len
                break
            if not pre_found:
                continue
            isolated = False
            last_idx = len(vol) - 2
            for k in range(max(1, lo), i + 1):
                if k >= len(vol) - 1 or k > last_idx:
                    continue
                l, r = vol[k - 1], vol[k + 1]
                if l > 0 and r > 0 and vol[k] >= max(l, r) * v['isolatedRatio']:
                    isolated = True
                    break
            if isolated:
                continue
            mid_at = mid[s2]
            touch = price[s2]
            if not mid_at > 0:
                break
            if touch < mid_at * (1 - near_pct / 100.0):
                break
            peak = max(price[s1:s2 + 1])
            trough = min(price[s1:s2 + 1])
            if not peak > 0 or not trough > 0:
                break
            drop = (peak - trough) / peak * 100
            rise = (price[i] / trough - 1) * 100
            if drop < v['dropPct'] and rise < v['dropPct']:
                continue
            return {'preLen': pre_len, 'preMul': pre_avg / s_avg, 'sLen': s_len, 'upLen': up_len}
    return None


def to_minute(t):
    return int(t[:2]) * 60 + int(t[3:5])


def find_trigger(price, vol, mid, minutes, prev, p):
    from_min = to_minute(p['window']['from'])
    to_min = to_minute(p['window']['to'])
    wait = int(p['entry']['waitBars'])
    require_rising = p['entry']['requireRising']
    require_above_mid = p['mid']['requireAboveMid']
    dd, bh, fl, mpg = p.get('deepDrop'), p.get('breakHigh'), p.get('fromLow'), p.get('maxPrevGain')
    n = len(price)
    pre_low = [0.0] * n
    pre_high = [0.0] * n
    run_lo = float('inf')
    run_hi = float('-inf')
    for k in range(n):
        run_lo = min(run_lo, price[k])
        pre_low[k] = run_lo
        pre_high[k] = run_hi  # 不含当根
        run_hi = max(run_hi, price[k])
    for i in range(n):
        if minutes[i] < from_min:
            continue
        if minutes[i] > to_min:
            break
        if p['shape']['enabled'] and not shape_ok(price, i, p['shape']['look'], p['shape']['maxFlips']):
            continue
        vs = volume_shape(price, vol, mid, i, p['vol'], p['mid']['nearPct'])
        if not vs:
            continue
        for j in range(i, min(i + wait, n - 1) + 1):
            if minutes[j] > to_min:
                break
            if p['shape']['enabled'] and not shape_ok(price, j, p['shape']['look'], p['shape']['maxFlips']):
                continue
            pr = price[j]
            if not pr >= prev:
                continue
            if require_above_mid and not mid[j] > 0:
                continue
            if require_above_mid and not pr >= mid[j]:
                continue
            if require_rising and not price[j] > price[j - 1]:
                continue
            gain = (pr / prev - 1) * 100
            if gain < p['gain']['min'] - 1e-9 or gain > p['gain']['max'] + 1e-9:
                continue
            if mpg and mpg.get('enabled') and pre_high[j] > float('-inf'):
                pg = (pre_high[j] / prev - 1) * 100
                if pg < mpg['minPct'] - 1e-9 or pg > mpg['maxPct'] + 1e-9:
                    continue
            if dd and dd.get('enabled'):
                dip = (prev - pre_low[j]) / prev * 100
                if dip > dd['maxPct'] + 1e-9:
                    continue
            if bh and bh.get('enabled') and pre_high[j] > float('-inf') and not pr > pre_high[j]:
                continue
            if fl and fl.get('enabled'):
                lift = (pr - pre_low[j]) / prev * 100
                if lift > fl['maxPct'] + 1e-9:
                    continue
            return {'j': j, 'anchor': i, 'gain': gain, 'vs': vs}
    return None


def do_run():
    strat = json.load(open(os.path.join(WS, 'strategies', 'intraday-strong.json')))
    p = strat['intraday']
    p.setdefault('entry', {'waitBars': 4, 'requireRising': True})
    p.setdefault('mid', {'requireAboveWater': False, 'requireAboveMid': True, 'nearPct': 0.8})
    p.setdefault('shape', {'enabled': True, 'look': 6, 'maxFlips': 2})
    p.setdefault('vol', {})
    p['vol'] = dict(dict(shrinkRatio=0.3, shrinkBurst=3, rebound=2.2, pileMin=3, prePileMin=3,
                         isolatedRatio=2, upMin=2, upMax=8, upPct=0.2, dropPct=0.25, look=20),
                    **p.get('vol', {}))
    cache = json.load(open(CACHE))
    stats = collections.Counter()
    sig = []
    bench = []
    for code, ctx in sorted(cache.items()):
        bars = ctx['day']
        if len(bars) < 60:
            stats['drop_short_bars'] += 1
            continue
        prev = ctx['prevClose']
        if not prev > 0:
            stats['drop_no_prev'] += 1
            continue
        minutes = [to_minute(b[0]) for b in bars]
        price = [b[4] for b in bars]
        vol = [b[5] for b in bars]
        hi = float('-inf')
        lo = float('inf')
        mid = []
        for x in price:
            hi = max(hi, x)
            lo = min(lo, x)
            mid.append((hi + lo) / 2)
        # 开盘幅度预筛（引擎第一道漏斗），用当日第一根的开盘价
        gap = (bars[0][1] / prev - 1) * 100
        stats['scanned'] += 1
        if gap < p['gap']['min'] - 1e-9 or gap > p['gap']['max'] + 1e-9:
            stats['drop_gap'] += 1
            continue
        # 基准：9:35 之后第一根收盘买入
        b0 = next((k for k, m in enumerate(minutes) if m >= to_minute('09:35')), None)
        if b0 is None:
            stats['drop_no_bench'] += 1
            continue
        bclose = price[-1]
        bench.append(((bclose / price[b0] - 1) * 100 - FEE,
                      ((ctx['nextOpen'] / price[b0] - 1) * 100 - FEE) if ctx['nextOpen'] else None))
        hit = find_trigger(price, vol, mid, minutes, prev, p)
        if not hit:
            stats['no_signal'] += 1
            continue
        j = hit['j']
        buy = price[j]
        if ctx['nextOpen'] is None:
            stats['drop_no_next'] += 1
        sig.append({
            'code': code, 't': bars[j][0], 'buy': buy,
            'gain': (buy / prev - 1) * 100,
            'close': bclose,
            'nextOpen': ctx['nextOpen'],
            'toClose': (bclose / buy - 1) * 100 - FEE,
            'toNext': ((ctx['nextOpen'] / buy - 1) * 100 - FEE) if ctx['nextOpen'] else None,
        })
    print('sample_stocks', len(cache), dict(stats), flush=True)
    print('signals', len(sig), flush=True)

    def rep(name, key, rows):
        vals = [r[key] for r in rows if r.get(key) is not None]
        if not vals:
            print(name, 'n=0'); return
        win = sum(1 for v in vals if v > 0) / len(vals) * 100
        avg = sum(vals) / len(vals)
        med = sorted(vals)[len(vals) // 2]
        print('%s n=%d 净收益均值=%.3f%% 中位=%.3f%% 胜率=%.1f%%' % (name, len(vals), avg, med, win), flush=True)
        # 简单 t 值（相对 0）
        mean = avg
        var = sum((v - mean) ** 2 for v in vals) / max(1, len(vals) - 1)
        se = (var / len(vals)) ** 0.5
        print('   t=%.2f  最好=%.2f%% 最差=%.2f%%' % (mean / se if se else 0, max(vals), min(vals)), flush=True)

    rep('策略·当日收盘出场', 'toClose', sig)
    rep('策略·次日开盘出场', 'toNext', sig)
    bclose_vals = [b[0] for b in bench]
    bnext_vals = [b[1] for b in bench if b[1] is not None]
    if bclose_vals:
        print('基准·9:35买入持到收盘 n=%d 均值=%.3f%% 胜率=%.1f%%'
              % (len(bclose_vals), sum(bclose_vals) / len(bclose_vals),
                 sum(1 for v in bclose_vals if v > 0) / len(bclose_vals) * 100), flush=True)
    if bnext_vals:
        print('基准·9:35买入持到次日开盘 n=%d 均值=%.3f%% 胜率=%.1f%%'
              % (len(bnext_vals), sum(bnext_vals) / len(bnext_vals),
                 sum(1 for v in bnext_vals if v > 0) / len(bnext_vals) * 100), flush=True)
    sig.sort(key=lambda r: r['t'])
    for r in sig[:40]:
        print('  %s %s 买入%.2f 涨幅%.2f%% 到收盘%.2f%% 到次日开盘%s'
              % (r['code'], r['t'], r['buy'], r['gain'], r['toClose'],
                 ('%.2f%%' % r['toNext']) if r['toNext'] is not None else 'NA'), flush=True)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if mode == 'fetch':
        do_fetch(int(sys.argv[2]) if len(sys.argv) > 2 else 100)
    else:
        do_run()
