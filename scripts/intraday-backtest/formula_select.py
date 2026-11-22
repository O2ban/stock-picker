#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按用户公式选股 → 验证今日表现

选股公式（全部只用决策时刻之前的信息）：
  0 基础池：沪深主板/创业板/科创板，剔 ST、剔停牌、剔北交所
  1 开盘幅度：-2% <= 开盘/前收-1 <= +1.5%
  2 触发点：价格从水下翻回水上，或突破分时前 5 分钟最高价
  3 确认：此刻「中」（当日累计最高最低均值）在水上
  4 量能：触发前 5 分钟均量 / 开盘至今均量 < 0.8（缩量）
  5 窗口：首触发时刻在 9:35 ~ 10:15
买入价 = 触发那一分钟的价格；卖出 = 当日收盘
"""
import json, re, ssl, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'}
FEE = 0.26
W_LO, W_HI = 575, 615          # 9:35 ~ 10:15（分钟数）


def get(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        raw = r.read()
    for enc in ('utf-8', 'gbk'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'ignore')


# ---------- 1. 全市场清单 ----------
def curl_json(url):
    import subprocess
    r = subprocess.run(['curl', '-s', '--max-time', '20', url],
                       capture_output=True)
    return json.loads(r.stdout.decode('utf-8', 'ignore'))


def all_codes():
    """穷举沪深全部合法代码段（快照接口不拒连，靠它验真伪）"""
    out = []
    for base, lo, hi in [('sh60', 0, 3999), ('sh605', 0, 999), ('sh688', 0, 999),
                         ('sz00', 1, 3999), ('sz30', 0, 1999)]:
        for n in range(lo, hi + 1):
            if base == 'sh60':
                c = 'sh60' + f'{n:04d}'
            else:
                c = base + f'{n:03d}'
            out.append((c, ''))
    return out


print('拉全市场股票清单...')
codes = all_codes()
print(f'基础池 {len(codes)} 只（已剔除北交所）')

# ---------- 2. 批量快照，先按开盘幅度粗筛 ----------
snap = {}


def snap_batch(batch):
    try:
        txt = get('https://qt.gtimg.cn/q=' + ','.join(batch))
    except Exception:
        return []
    out = []
    for line in txt.split(';'):
        line = line.strip()
        if '="' not in line: continue
        code = line.split('=')[0].replace('v_', '').strip()
        f = line.split('="', 1)[1].rstrip('"').split('~')
        if len(f) < 40: continue
        try:
            name, price, prev, openp = f[1], float(f[3]), float(f[4]), float(f[5])
        except (ValueError, IndexError):
            continue
        if price <= 0 or prev <= 0 or openp <= 0: continue
        if 'ST' in name or '退' in name: continue
        out.append((code, {'name': name, 'price': price, 'prev': prev, 'open': openp}))
    return out


batches = [c for c, _ in codes]
batch_list = [batches[i:i + 150] for i in range(0, len(batches), 150)]
with ThreadPoolExecutor(max_workers=8) as ex:
    for res in ex.map(snap_batch, batch_list):
        for code, d in res:
            snap[code] = d

print(f'快照取到 {len(snap)} 只')

gap_pool = []
for code, s in snap.items():
    gap = (s['open'] / s['prev'] - 1) * 100
    if -2 <= gap <= 1.5:
        s['gap'] = gap
        gap_pool.append(code)
print(f'开盘幅度在 -2%~+1.5% 的：{len(gap_pool)} 只（公式第 1 步通过）')

# ---------- 3. 并发拉分时 ----------
def timeline(code):
    url = f'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code={code}'
    j = json.loads(get(url))
    node = j.get('data', {}).get(code, {})
    d = node.get('data', {}) or {}
    pts, pv = [], 0.0
    for line in d.get('data', []) or []:
        f = str(line).split()
        if len(f) < 4: continue
        t = f[0]
        if not re.fullmatch(r'\d{4}', t): continue
        m = int(t[:2]) * 60 + int(t[2:])
        if not ((570 <= m <= 690) or (780 <= m <= 900)): continue
        try:
            price, cv = float(f[1]), float(f[2])
        except ValueError:
            continue
        pts.append({'t': t, 'm': m, 'price': price, 'vol': max(0.0, cv - pv)})
        pv = cv
    return pts


def load(code):
    try:
        pts = timeline(code)
    except Exception:
        return None
    if len(pts) < 60: return None
    return pts


print('拉分时数据（并发 16）...')
t0 = time.time()
tl = {}
with ThreadPoolExecutor(max_workers=16) as ex:
    for code, pts in zip(gap_pool, ex.map(load, gap_pool)):
        if pts: tl[code] = pts
print(f'分时到手 {len(tl)} 只，耗时 {time.time()-t0:.0f}s')

# ---------- 4. 套公式 ----------
rows = []
for code, pts in tl.items():
    s = snap[code]
    pc, close = s['prev'], pts[-1]['price']
    hi = lo = pts[0]['price']
    for p in pts:                      # 逐分钟滚动「中」，只用过去信息
        hi = max(hi, p['price']); lo = min(lo, p['price'])
        p['mid'] = (hi + lo) / 2
    f5hi = max(p['price'] for p in pts[:5])

    def vol_shrink(i):
        if i < 5: return False
        recent = sum(x['vol'] for x in pts[i - 4:i + 1]) / 5
        hist = sum(x['vol'] for x in pts[:i + 1]) / (i + 1)
        return hist > 0 and recent / hist < 0.8

    hit = None
    for i in range(5, len(pts)):
        if pts[i]['m'] < W_LO: continue
        if pts[i]['m'] > W_HI: break
        p = pts[i]
        back_up = p['price'] >= pc and any(x['price'] < pc for x in pts[:i])
        brk_hi = p['price'] > f5hi
        if not (back_up or brk_hi): continue
        if p['mid'] < pc: continue          # 中在水上
        if not vol_shrink(i): continue      # 缩量
        hit = (i, '翻上水面' if back_up else '过分时前高')
        break

    rows.append({
        'code': code, 'name': s['name'], 'gap': round(s['gap'], 2),
        'chg': round((close / pc - 1) * 100, 2),
        'high': round((max(p['price'] for p in pts) / pc - 1) * 100, 2),
        'hit': hit[1] if hit else '', 't': pts[hit[0]]['t'] if hit else '',
        'buy': pts[hit[0]]['price'] if hit else None,
        'ret': (close / pts[hit[0]]['price'] - 1) * 100 - FEE if hit else None,
        'mins': len(pts),
    })

sel = [r for r in rows if r['hit']]
sel.sort(key=lambda r: r['t'])

print(f'\n===== 公式筛出 {len(sel)} 只（共扫 {len(rows)} 只合格票）=====')
if sel:
    print(f'{"代码":9s}{"名称":12s}{"开盘%":>7s}{"买入时刻":>8s}{"买点":>7s}{"收盘%":>7s}'
          f'{"最高%":>7s}{"净收益":>8s}{"形态":>10s}')
    for r in sel:
        nm = r['name'][:10]
        print(f'{r["code"]:9s}{nm:12s}{r["gap"]:+7.2f}{r["t"]:>8s}{r["buy"]:>7.2f}'
              f'{r["chg"]:+7.2f}{r["high"]:+7.2f}{r["ret"]:+7.2f}%{r["hit"]:>10s}')

# ---------- 5. 对照 ----------
if sel:
    rets = [r['ret'] for r in sel]
    n = len(rets)
    print(f'\n选出的 {n} 只：平均净收益 {sum(rets)/n:+.2f}%，'
          f'赚 {sum(1 for x in rets if x>0)} 亏 {sum(1 for x in rets if x<=0)}，'
          f'最好 {max(rets):+.2f}% 最差 {min(rets):+.2f}%')

allchg = [r['chg'] for r in rows]
print(f'全部合格票（{len(rows)} 只）当日平均涨跌：{sum(allchg)/len(allchg):+.2f}%，'
      f'收红 {sum(1 for x in allchg if x>0)} 只')
print('\n注意：今日大盘下跌，绝对收益会被行情拖累，'
      '下面「超额」才是策略本身的能力')

json.dump(rows, open('/tmp/gongshi_sel.json', 'w'), ensure_ascii=False, indent=1)
print('明细已存 /tmp/gongshi_sel.json')
