#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拉一次今日全市场分时存盘，供分层分析反复使用"""
import gzip, json, os, re, ssl, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'}
OUT = '/tmp/tl_all.json.gz'


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


def all_codes():
    out = []
    for base, lo, hi in [('sh60', 0, 3999), ('sh605', 0, 999), ('sh688', 0, 999),
                         ('sz00', 1, 3999), ('sz30', 0, 1999)]:
        for n in range(lo, hi + 1):
            out.append('sh60' + f'{n:04d}' if base == 'sh60' else base + f'{n:03d}')
    return out


def snap_batch(batch):
    try:
        txt = get('https://qt.gtimg.cn/q=' + ','.join(batch))
    except Exception:
        return []
    res = []
    for line in txt.split(';'):
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
        res.append((code, name, price, prev, openp))
    return res


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
        pts.append([t, price, max(0.0, cv - pv)])
        pv = cv
    return pts


if os.path.exists(OUT):
    print(f'{OUT} 已存在，跳过拉取'); sys.exit(0)

print('枚举代码并快照...')
codes = all_codes()
batches = [codes[i:i + 150] for i in range(0, len(codes), 150)]
snap = {}
with ThreadPoolExecutor(max_workers=8) as ex:
    for res in ex.map(snap_batch, batches):
        for code, name, price, prev, openp in res:
            snap[code] = {'name': name, 'price': price, 'prev': prev, 'open': openp}
print(f'快照 {len(snap)} 只')

print('拉分时（并发 16）...')
t0 = time.time()
store = {}
with ThreadPoolExecutor(max_workers=16) as ex:
    for code, pts in zip(snap.keys(), ex.map(timeline, snap.keys())):
        if len(pts) >= 60:
            store[code] = {'s': snap[code], 'p': pts}
print(f'到手 {len(store)} 只，耗时 {time.time()-t0:.0f}s')

with gzip.open(OUT, 'wt', encoding='utf-8') as f:
    json.dump(store, f, ensure_ascii=False)
print(f'已存 {OUT} ({os.path.getsize(OUT)/1e6:.1f} MB)')
