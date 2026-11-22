# -*- coding: utf-8 -*-
"""2026-08-06 一分钟口径回测（intraday-strong）。

数据源：
  · 1 分钟 K 线 —— 本地 eltdx（通达信 7709 协议），bars.get(period='1min', anchor_date=DAY)
    已实测：当日 240 根（09:31→15:00），逐股聚合成 o/h/l/c/vol 与 kline.db 日线**原始价**完全一致。
  · 昨收 / 次日开盘 —— kline.db daily_kline 的 *_raw 字段（原始价，与 1 分钟同口径，无复权错位）。

两段式：
  fetch  —— 为池内股票抓「2026-08-05 昨收 / 08-06 全天分钟 / 08-07 开盘」，增量写缓存
  run    —— 按 src/intraday.js 的 findTrigger 一比一复现买点，算当日收盘与次日开盘两种出场

口径纪律：
  · 决策只用当根及之前的分钟数据；前高 preHigh 不含当根，前低 preLow 含当根；
  · 买入价 = 触发那根一分钟的收盘价；
  · 费用双边合计 0.26%；
  · 剔除样本单独分类统计：停牌 / 涨停封死买不进 / 空数据 / K 线不足 / 缺次日开盘；
  · 请求失败（bad）单独计数，绝不并入停牌或空数据。
"""
import json, os, sys, time, sqlite3, collections

DAY = '2026-08-06'
PREV = '2026-08-05'
NEXT = '2026-08-07'
ROOT = os.path.dirname(os.path.abspath(__file__))
WS = os.path.abspath(os.path.join(ROOT, '..', '..'))
DATA = os.path.join(WS, 'data', 'intraday-min', DAY)
CACHE = os.path.join(DATA, '_ctx.json')
FEE = 0.26
KDB = '/home/ubuntu/kline-trainer/kline-server/data/kline.db'
BOARDS = ('sh_main', 'sz_main', 'sz_gem', 'sh_star')


def db():
    return sqlite3.connect('file:%s?mode=ro' % KDB, uri=True)


def load_pool():
    """池子：日线库里有 2026-08-06 记录、且属沪深主板/创业板/科创板（不含北交所）。"""
    con = db()
    cur = con.cursor()
    cur.execute("select code, board, name from stocks where board in (%s)"
                % ','.join('?' * len(BOARDS)), BOARDS)
    meta = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    cur.execute("select code from daily_kline where date=?", (DAY,))
    have = set(r[0] for r in cur.fetchall())
    con.close()
    return sorted(c for c in meta if c in have), meta


def load_daily(codes):
    """一次取出全部股票的 昨收(8/5 close_raw) / 当日行 / 次日(8/7 open_raw, close_raw)。"""
    con = db()
    cur = con.cursor()
    out = {}
    chunk = 900
    for i in range(0, len(codes), chunk):
        part = codes[i:i + chunk]
        q = ('select code,date,open_raw,high_raw,low_raw,close_raw,vol from daily_kline '
             'where date in (?,?,?) and code in (%s)' % ','.join('?' * len(part)))
        cur.execute(q, (PREV, DAY, NEXT) + tuple(part))
        for code, date, o, h, l, c, v in cur.fetchall():
            d = out.setdefault(code, {})
            d[date] = (o, h, l, c, v)
    con.close()
    return out


# ---------------- 引擎复现（与 src/intraday.js 一致） ----------------

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


def find_triggers(price, vol, mid, minutes, prev, p):
    """返回窗口内全部触发点（按时间升序）。同一 anchor 只取第一个可买点。"""
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
    hits = []
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
            hits.append({'j': j, 'anchor': i, 'gain': gain, 'vs': vs})
            break
    return hits


# ---------------- 抓取 ----------------

def do_fetch(limit):
    import eltdx
    os.makedirs(DATA, exist_ok=True)
    pool, meta = load_pool()
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    todo = [c for c in pool if c not in cache]
    print('pool', len(pool), 'cached', len(cache), 'todo', len(todo), flush=True)
    if not todo:
        print('nothing to fetch', flush=True)
        return
    part = todo[:limit]
    daily = load_daily(part) if limit > 0 else {}
    cli = eltdx.TdxClient()
    cli.connect()
    cnt = collections.Counter()
    t0 = time.time()
    try:
        for i, code in enumerate(part, 1):
            try:
                r = cli.bars.get(code, period='1min', start=0, count=800, anchor_date=DAY)
                bars = [b for b in r.bars if b.time.strftime('%Y-%m-%d') == DAY]
                d = daily.get(code, {})
                pd_ = d.get(PREV)
                nd = d.get(NEXT)
                rec = {
                    'prevClose': pd_[3] if pd_ else None,
                    'day': [[b.time.strftime('%H:%M'), b.open, b.high, b.low, b.close,
                             float(b.volume_lots or 0)] for b in bars],
                    'dayVol': d.get(DAY, (None,) * 5)[4],
                    'nextOpen': nd[0] if nd else None,
                    'nextClose': nd[3] if nd else None,
                }
                if not bars:
                    cnt['empty'] += 1
                elif rec['prevClose'] is None:
                    cnt['no_prev'] += 1
                else:
                    cnt['ok'] += 1
                cache[code] = rec
            except Exception as e:
                cnt['bad'] += 1
                if cnt['bad'] <= 5:
                    print('BAD', code, type(e).__name__, e, flush=True)
            if i % 200 == 0:
                print('fetch', i, dict(cnt), 'sec', round(time.time() - t0, 1), flush=True)
                json.dump(cache, open(CACHE + '.part', 'w'))
                os.replace(CACHE + '.part', CACHE)
    finally:
        cli.close()
    json.dump(cache, open(CACHE + '.part', 'w'))
    os.replace(CACHE + '.part', CACHE)
    print('fetch_done', len(part), dict(cnt), 'cached_total', len(cache),
          'sec', round(time.time() - t0, 1), flush=True)


# ---------------- 结算 ----------------

LIMIT_PCT = {'sh_main': 0.10, 'sz_main': 0.10, 'sz_gem': 0.20, 'sh_star': 0.20}


def do_run():
    strat = json.load(open(os.path.join(WS, 'strategies', 'intraday-strong.json')))
    p = strat['intraday']
    p.setdefault('entry', {'waitBars': 4, 'requireRising': True})
    p.setdefault('mid', {'requireAboveWater': False, 'requireAboveMid': True, 'nearPct': 0.8})
    p.setdefault('shape', {'enabled': True, 'look': 6, 'maxFlips': 2})
    p['vol'] = dict(dict(shrinkRatio=0.3, shrinkBurst=3, rebound=2.2, pileMin=3, prePileMin=3,
                         isolatedRatio=2, upMin=2, upMax=8, upPct=0.2, dropPct=0.25, look=20),
                    **p.get('vol', {}))
    pool, meta = load_pool()
    cache = json.load(open(CACHE))
    stats = collections.Counter()
    sig = []
    bench = []
    multi = 0
    triggers_total = 0
    for code in pool:
        ctx = cache.get(code)
        if ctx is None:
            stats['drop_not_fetched'] += 1
            continue
        bars = ctx['day']
        board, name = meta.get(code, ('', ''))
        if not bars:
            # 有日线记录但当日无分钟数据：区分停牌与空数据
            if ctx.get('dayVol') is None:
                stats['drop_suspended'] += 1
            elif ctx['dayVol'] == 0:
                stats['drop_suspended'] += 1
            else:
                stats['drop_empty'] += 1
            continue
        prev = ctx['prevClose']
        if not prev or prev <= 0:
            stats['drop_no_prev'] += 1
            continue
        if len(bars) < 60:
            stats['drop_short_bars'] += 1
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
        stats['scanned'] += 1
        # 开盘幅度预筛（引擎第一道漏斗）
        gap = (bars[0][1] / prev - 1) * 100
        if gap < p['gap']['min'] - 1e-9 or gap > p['gap']['max'] + 1e-9:
            stats['drop_gap'] += 1
            continue
        # 基准：9:35 之后第一根收盘买入
        b0 = next((k for k, m in enumerate(minutes) if m >= to_minute('09:35')), None)
        if b0 is None:
            stats['drop_no_bench'] += 1
            continue
        bclose = price[-1]
        bench.append({
            'code': code,
            'toClose': (bclose / price[b0] - 1) * 100 - FEE,
            'toNext': ((ctx['nextOpen'] / price[b0] - 1) * 100 - FEE) if ctx['nextOpen'] else None,
        })
        hits = find_triggers(price, vol, mid, minutes, prev, p)
        if not hits:
            stats['no_signal'] += 1
            continue
        triggers_total += len(hits)
        if len(hits) > 1:
            multi += 1
        h = hits[0]                      # 实际盯盘按代码去重只记首笔
        j = h['j']
        buy = price[j]
        # 涨停封死买不进判定：买点收盘价触及涨停价，且该分钟几乎无价格空间
        lim = round(prev * (1 + LIMIT_PCT.get(board, 0.10)), 2)
        if buy >= lim - 1e-6 and (bars[j][2] - bars[j][3]) <= lim * 0.002:
            stats['drop_limit_up'] += 1
            continue
        rec = {
            'code': code, 'name': name, 'board': board, 't': bars[j][0],
            'anchor': bars[h['anchor']][0], 'buy': buy,
            'gain': h['gain'], 'close': bclose, 'nextOpen': ctx['nextOpen'],
            'toClose': (bclose / buy - 1) * 100 - FEE,
            'toNext': ((ctx['nextOpen'] / buy - 1) * 100 - FEE) if ctx['nextOpen'] else None,
        }
        if ctx['nextOpen'] is None:
            stats['sig_without_next'] += 1
        sig.append(rec)

    print('=' * 72, flush=True)
    print('回测日 %s（前一交易日 %s / 次一交易日 %s）  1分钟K线口径  费率双边 %.2f%%'
          % (DAY, PREV, NEXT, FEE), flush=True)
    print('股票池=沪深主板+创业板+科创板，日线库当日有记录 %d 只；实际取到分钟数据并扫描 %d 只'
          % (len(pool), stats['scanned']), flush=True)
    print('剔除分类：', flush=True)
    for k, lab in (('drop_not_fetched', '未抓取'), ('drop_suspended', '停牌/当日无成交'),
                   ('drop_empty', '空数据'), ('drop_short_bars', 'K线不足60根'),
                   ('drop_no_prev', '缺昨收'), ('drop_gap', '开盘幅度预筛挡掉'),
                   ('drop_no_bench', '无9:35后基准bar'), ('drop_limit_up', '涨停封死买不进')):
        if stats[k]:
            print('   %-14s %d' % (lab, stats[k]), flush=True)
    print('无信号（no_signal）%d' % stats['no_signal'], flush=True)
    print('出票（按代码去重）%d 只；窗口内触发点合计 %d 个，其中 %d 只出现多次触发只记首笔'
          % (len(sig), triggers_total, multi), flush=True)

    def rep(name, key, rows):
        vals = [r[key] for r in rows if r.get(key) is not None]
        if not vals:
            print('%s n=0' % name, flush=True)
            return
        win = sum(1 for v in vals if v > 0) / len(vals) * 100
        avg = sum(vals) / len(vals)
        med = sorted(vals)[len(vals) // 2]
        mean = avg
        var = sum((v - mean) ** 2 for v in vals) / max(1, len(vals) - 1)
        se = (var / len(vals)) ** 0.5
        print('%s n=%d 净收益均值=%.3f%% 中位=%.3f%% 胜率=%.1f%% t=%.2f 最好=%.2f%% 最差=%.2f%%'
              % (name, len(vals), avg, med, win, mean / se if se else 0, max(vals), min(vals)),
              flush=True)

    rep('策略·当日收盘出场', 'toClose', sig)
    rep('策略·次日开盘出场', 'toNext', sig)
    b1 = [b['toClose'] for b in bench]
    b2 = [b['toNext'] for b in bench if b['toNext'] is not None]
    if b1:
        print('基准·9:35买入持到收盘 n=%d 均值=%.3f%% 胜率=%.1f%%'
              % (len(b1), sum(b1) / len(b1), sum(1 for v in b1 if v > 0) / len(b1) * 100), flush=True)
    if b2:
        print('基准·9:35买入持到次日开盘 n=%d 均值=%.3f%% 胜率=%.1f%%'
              % (len(b2), sum(b2) / len(b2), sum(1 for v in b2 if v > 0) / len(b2) * 100), flush=True)
    if sig:
        # 超额：策略 vs 同股票池基准（同一批通过预筛的股票）
        sa = sum(r['toClose'] for r in sig) / len(sig)
        print('超额·当日收盘出场 策略%.3f%% - 预筛池基准%.3f%% = %+.3f 个百分点'
              % (sa, sum(b1) / len(b1), sa - sum(b1) / len(b1)), flush=True)
        sn = [r['toNext'] for r in sig if r['toNext'] is not None]
        if sn and b2:
            print('超额·次日开盘出场 策略%.3f%% - 预筛池基准%.3f%% = %+.3f 个百分点'
                  % (sum(sn) / len(sn), sum(b2) / len(b2), sum(sn) / len(sn) - sum(b2) / len(b2)),
                  flush=True)
        print('-' * 72, flush=True)
        sig.sort(key=lambda r: r['t'])
        for r in sig:
            print('  %s %-6s %s 买%.2f 涨幅%.2f%% 到收盘%+.2f%% 到次日开盘%s'
                  % (r['code'], r['name'][:6], r['t'], r['buy'], r['gain'], r['toClose'],
                     ('%+.2f%%' % r['toNext']) if r['toNext'] is not None else 'NA'), flush=True)
    json.dump({'sig': sig, 'bench': bench, 'stats': dict(stats)},
              open(os.path.join(DATA, '_result.json'), 'w'), ensure_ascii=False, indent=1)
    print('结果已写入 data/intraday-min/%s/_result.json' % DAY, flush=True)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if mode == 'fetch':
        do_fetch(int(sys.argv[2]) if len(sys.argv) > 2 else 900)
    else:
        do_run()
