#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""今日分时特征验证（应用同款分时接口 / 1 分钟粒度）

核心口径：
1. 随机抽票，不用历史样本池，避免挑样本
2. 触发决策只用「那一刻之前」的信息，不用未来数据
3. 收益看「同分钟对齐超额」= 我这笔 - 同一分钟随便买同批票持到收盘
   单日大盘普跌时不这样对齐，会把亏损记在策略头上
"""
import json, random, ssl, sys, time, urllib.request, re

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'}
FEE = 0.26
NSAMPLE = 120


def get(url, timeout=12):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        raw = r.read()
    for enc in ('utf-8', 'gbk'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'ignore')


def rand_codes(n):
    out = set()
    while len(out) < n:
        b = random.choice(['sh60', 'sh688', 'sz00', 'sz30'])
        if b == 'sh60': c = 'sh60' + f'{random.randint(0, 3999):04d}'
        elif b == 'sh688': c = 'sh688' + f'{random.randint(1, 999):03d}'
        elif b == 'sz00': c = 'sz00' + f'{random.randint(1, 3999):04d}'
        else: c = 'sz30' + f'{random.randint(1, 1999):04d}'
        out.add(c)
    return sorted(out)


# ---- 1. 随机取样 + 有效性校验 ----
cands = rand_codes(420)
valid = []
for i in range(0, len(cands), 60):
    batch = cands[i:i + 60]
    try:
        txt = get('https://qt.gtimg.cn/q=' + ','.join(batch))
    except Exception:
        continue
    for line in txt.split(';'):
        line = line.strip()
        if not line or '="' not in line: continue
        code = line.split('=')[0].replace('v_', '').strip()
        body = line.split('="', 1)[1].rstrip('"')
        f = body.split('~')
        if len(f) < 40: continue
        name, price, prev = f[1], f[3], f[4]
        try:
            p, pv = float(price), float(prev)
        except ValueError:
            continue
        if p <= 0 or pv <= 0: continue
        if 'ST' in name or '退' in name: continue
        valid.append((code, name, p, pv))
    time.sleep(0.12)

print(f'随机探测 {len(cands)} 个代码，有效 {len(valid)} 只')
random.shuffle(valid)
picked = sorted(valid[:NSAMPLE], key=lambda x: x[0])
print(f'抽取 {len(picked)} 只作为今日样本\n')


def timeline(code):
    url = f'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code={code}'
    j = json.loads(get(url))
    node = j.get('data', {}).get(code, {})
    d = node.get('data', {})
    date = d.get('date', '')
    pts, pv = [], 0.0
    for line in d.get('data', []):
        f = str(line).split()
        if len(f) < 4: continue
        t = f[0]
        if not re.fullmatch(r'\d{4}', t): continue
        m = int(t[:2]) * 60 + int(t[2:])
        if not ((570 <= m <= 690) or (780 <= m <= 900)): continue
        try:
            price, cv, ca = float(f[1]), float(f[2]), float(f[3])
        except ValueError:
            continue
        pts.append({'t': t, 'm': m, 'price': price,
                    'vol': max(0.0, cv - pv), 'cumVol': cv,
                    'avg': ca / (cv * 100) if cv > 0 else None})
        pv = cv
    prev_close = None
    qt = node.get('qt', {}).get(code)
    if isinstance(qt, list) and len(qt) > 4:
        try: prev_close = float(qt[4])
        except (TypeError, ValueError): prev_close = None
    return date, prev_close, pts


# ---- 2. 拉数据 + 算特征 ----
stocks = []
for code, name, price, prevq in picked:
    try:
        date, prev, pts = timeline(code)
    except Exception as e:
        continue
    if not pts or not prev or prev <= 0 or len(pts) < 60:
        continue
    pc = prev
    # 中线「中」= 当日累计最高最低均值，逐分钟滚动（只用当下之前的信息）
    hi = lo = pts[0]['price']
    for p in pts:
        hi = max(hi, p['price']); lo = min(lo, p['price'])
        p['mid'] = (hi + lo) / 2
        p['runhi'] = hi
    stocks.append({'code': code, 'name': name, 'pc': pc, 'pts': pts,
                   'open': pts[0]['price'], 'close': pts[-1]['price'],
                   'gap': (pts[0]['price'] / pc - 1) * 100,
                   'chg': (pts[-1]['price'] / pc - 1) * 100})

if len(stocks) < 40:
    print(f'有效样本仅 {len(stocks)} 只，太少'); sys.exit(1)

print(f'成功取得 {len(stocks)} 只今日分时（{stocks[0]["pts"][0]["t"]}~{stocks[0]["pts"][-1]["t"]}），'
      f'粒度 1 分钟\n')

# 同分钟基准：某分钟买入、持到收盘的收益（所有样本平均）
bench = {}
for s in stocks:
    for i, p in enumerate(s['pts']):
        bench.setdefault(i, []).append(s['close'] / p['price'] - 1)
bench = {i: sum(v) / len(v) for i, v in bench.items()}

# 基准1：9:35 全样本随便买持到收盘
b935 = [s['close'] / s['pts'][4]['price'] - 1 for s in stocks if len(s['pts']) > 4]
print(f'【今日底色】全样本 9:35 随便买持到收盘（扣费前）：平均 {sum(b935)/len(b935)*100:+.2f}%')
print(f'　全样本当日涨跌：平均 {sum(s["chg"] for s in stocks)/len(stocks):+.2f}%，'
      f'收红 {sum(1 for s in stocks if s["chg"]>0)}/{len(stocks)} 只')
print()

# ---- 3. 定义触发条件（窗口 9:35~10:15，只用历史信息）----
W_LO, W_HI = 575, 615   # 9:35 ~ 10:15


def first_idx(s, fn, start=0, end=len(10**9) if False else 240):
    for i in range(start, min(end, len(s['pts']))):
        if fn(s, i):
            return i
    return None


def ev_back_up(s, i):
    """从水下翻回水上：开盘曾跌破前收，此刻首次 >= 前收"""
    p = s['pts'][i]
    if p['price'] < s['pc']: return False
    return any(s['pts'][k]['price'] < s['pc'] for k in range(i))


def ev_break_hi(s, i):
    """过分时前高：突破开盘前 5 分钟最高价"""
    f5 = max(x['price'] for x in s['pts'][:5])
    return s['pts'][i]['price'] > f5 and i >= 5


def ev_cross_mid(s, i):
    """价格上穿「中」线"""
    return s['pts'][i]['price'] > s['pts'][i]['mid'] and \
           (i == 0 or s['pts'][i - 1]['price'] <= s['pts'][i - 1]['mid'])


def vol_shrink(s, i):
    """触发前 5 分钟量 vs 开盘到现在的每分钟均量，<0.8 算缩量（纯历史）"""
    if i < 5: return False
    recent = sum(x['vol'] for x in s['pts'][i - 4:i + 1]) / 5
    hist = sum(x['vol'] for x in s['pts'][:i + 1]) / (i + 1)
    return hist > 0 and recent / hist < 0.8


def mid_above(s, i):
    """此刻「中」在水上"""
    return s['pts'][i]['mid'] >= s['pc']


def gap_ok(s, i):
    return -2 <= s['gap'] <= 1.5


EVENTS = {
    '翻上水面': ev_back_up,
    '过分时前高': ev_break_hi,
    '上穿中线': ev_cross_mid,
}
FILTERS = {
    '': lambda s, i: True,
    '＋中在水上': mid_above,
    '＋缩量': vol_shrink,
    '＋中在水上＋缩量': lambda s, i: mid_above(s, i) and vol_shrink(s, i),
    '＋开盘幅度-2~1.5%': gap_ok,
    '＋全部（中+缩量+幅度）': lambda s, i: mid_above(s, i) and vol_shrink(s, i) and gap_ok(s, i),
}

stats = {}
for ename, efn in EVENTS.items():
    for fname, ffn in FILTERS.items():
        key = ename + fname
        rets, exs, ts = [], [], []
        for s in stocks:
            i = None
            for k in range(W_LO, min(W_HI + 1, len(s['pts']))):
                mi = s['pts'][k]['m']
                if k < 4: continue
                if mi < W_LO or mi > W_HI: continue
                if efn(s, k) and ffn(s, k):
                    i = k; break
            if i is None: continue
            buy = s['pts'][i]['price']
            r = s['close'] / buy - 1 - FEE / 100
            rets.append(r)
            exs.append(r - bench[i])
            ts.append(s['pts'][i]['t'])
        if rets:
            n = len(rets)
            m = sum(rets) / n
            e = sum(exs) / n
            sd = (sum((x - e) ** 2 for x in exs) / max(1, n - 1)) ** 0.5
            t = e / (sd / n ** 0.5) if sd > 0 else 0
            w = sum(1 for x in rets if x > 0) / n * 100
            stats[key] = (n, m * 100, w, e * 100, t)

hdr = f'{"触发条件":26s}{"次数":>6s}{"净收益":>9s}{"胜率":>7s}{"超额":>9s}{"t值":>7s}'
print(f'===== 今日各条件表现（9:35~10:15 窗口，首次触发买入，持到收盘，扣 {FEE}%）=====')
print(hdr)
for key, (n, m, w, e, t) in stats.items():
    if key.startswith('翻上水面') or key.startswith('过分时前高'):
        print(f'{key:26s}{n:6d}{m:+8.2f}%{w:6.0f}%{e:+8.3f}%{t:+7.2f}')
print()
for key, (n, m, w, e, t) in stats.items():
    if key.startswith('上穿中线'):
        print(f'{key:26s}{n:6d}{m:+8.2f}%{w:6.0f}%{e:+8.3f}%{t:+7.2f}')

# 次日开盘卖无法验证（今天还没到明天），说明清楚
out = {'date': stocks[0]['pts'] and None, 'n': len(stocks), 'stats': {k: list(v) for k, v in stats.items()},
       'detail': [{'code': s['code'], 'name': s['name'], 'gap': round(s['gap'], 2),
                   'chg': round(s['chg'], 2), 'close': s['close'],
                   'high_ret': round((max(p['price'] for p in s['pts']) / s['pc'] - 1) * 100, 2)}
                  for s in stocks]}
json.dump(out, open('/tmp/today_intraday.json', 'w'), ensure_ascii=False, indent=1)

# ---- 4. 形态描述性统计 ----
n = len(stocks)
below = sum(1 for s in stocks if any(p['price'] < s['pc'] for p in s['pts']))
back10 = 0
for s in stocks:
    for k in range(1, len(s['pts'])):
        if s['pts'][k]['price'] >= s['pc'] and any(p['price'] < s['pc'] for p in s['pts'][:k]):
            if s['pts'][k]['t'] <= '1000': back10 += 1
            break
print(f'\n===== 今日形态统计（{n} 只）=====')
print(f'盘中曾跌破水面：{below} 只（{below/n*100:.0f}%）')
print(f'10 点前回到水面：{back10} 只（{back10/n*100:.0f}%）')
print(f'收盘价高于前收：{sum(1 for s in stocks if s["chg"]>0)} 只（{sum(1 for s in stocks if s["chg"]>0)/n*100:.0f}%）')
print(f'开盘幅度 -2%~+1.5%：{sum(1 for s in stocks if -2<=s["gap"]<=1.5)} 只'
      f'（{sum(1 for s in stocks if -2<=s["gap"]<=1.5)/n*100:.0f}%）')
print('\n明细已存 /tmp/today_intraday.json')
