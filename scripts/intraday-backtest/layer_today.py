#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""今日全市场分时分层验证：逐条加条件，看筛出多少只、表现怎样

口径说明：
- 买入价 = 触发那一分钟的价格（决策时刻，无未来信息）
- 卖出 = 当日收盘（次日开盘卖今天无法验证）
- 净收益扣 0.26% 手续费
- 超额 = 我这笔净收益 - 同一分钟买入全市场样本的平均净收益
  单日大盘普跌，不看超额就会把行情亏损误判成策略无效
"""
import gzip, json, sys

FEE = 0.26
W_LO, W_HI = 575, 615   # 9:35 ~ 10:15

store = json.load(gzip.open('/tmp/tl_all.json.gz', 'rt', encoding='utf-8'))
print(f'载入 {len(store)} 只今日分时')

S = []
for code, d in store.items():
    s, pts = d['s'], d['p']
    pc = s['prev']
    P = [p[1] for p in pts]
    if min(P) <= 0: continue
    hi = lo = P[0]
    mids, runhi = [], []
    for x in P:
        hi = max(hi, x); lo = min(lo, x)
        mids.append((hi + lo) / 2); runhi.append(hi)
    S.append({'code': code, 'name': s['name'], 'pc': pc, 'open': s['open'],
              'gap': (s['open'] / pc - 1) * 100,
              'pts': pts, 'P': P, 'mid': mids, 'runhi': runhi,
              'vol': [p[2] for p in pts],
              'close': P[-1], 'chg': (P[-1] / pc - 1) * 100})
print(f'有效 {len(S)} 只')

# 同分钟基准：全市场在该分钟买入持到收盘的平均毛收益
from collections import defaultdict
acc = defaultdict(list)
for x in S:
    for i, p in enumerate(x['P']):
        acc[i].append(x['close'] / p - 1)
BENCH = {i: sum(v) / len(v) for i, v in acc.items()}

b935 = [x['close'] / x['P'][4] - 1 for x in S if len(x['P']) > 4]
print(f'\n【今日底色】全市场 9:35 买入持到收盘：毛 {sum(b935)/len(b935)*100:+.2f}%，'
      f'扣费 {sum(b935)/len(b935)*100-FEE:+.2f}%')
print(f'全市场当日平均涨跌 {sum(x["chg"] for x in S)/len(S):+.2f}%，'
      f'收红 {sum(1 for x in S if x["chg"]>0)}/{len(S)}\n')


def shrink_at(x, i, win=5, thr=0.8):
    """触发前 win 分钟均量 / 开盘至今均量"""
    if i < win: return None
    recent = sum(x['vol'][i - win + 1:i + 1]) / win
    hist = sum(x['vol'][:i + 1]) / (i + 1)
    return recent / hist if hist > 0 else None


def shake_ok(x, i, up_thr=0.5, vol_ratio=0.85):
    """震荡验证：先拉起≥up_thr%，再砸回，砸的过程量能缩，此刻已回水上
    全部只用 i 之前的信息"""
    pc = x['pc']; P = x['P'][:i + 1]; V = x['vol'][:i + 1]
    peak = -1; peak_i = -1
    for k in range(len(P)):
        r = (P[k] / pc - 1) * 100
        if r >= up_thr and P[k] > peak:
            peak, peak_i = P[k], k
    if peak_i < 0: return False
    # 峰之后必须有过回落（最低点低于峰价）
    after = P[peak_i:]
    if not after: return False
    low_i = peak_i + min(range(len(after)), key=lambda k: after[k])
    if low_i <= peak_i: return False
    drop = (peak - P[low_i]) / peak * 100
    if drop < 0.3: return False                    # 确实砸下去过
    # 砸下来那段量能要缩
    up_seg = V[max(0, peak_i - 4):peak_i + 1]
    dn_seg = V[peak_i + 1:low_i + 1]
    if not dn_seg or not up_seg: return False
    if sum(dn_seg) / len(dn_seg) / max(1e-9, sum(up_seg) / len(up_seg)) > vol_ratio:
        return False
    return True


def find_trigger(x, use_shake=False, need_mid=True, need_shrink=True,
                 shrink_thr=0.8, need_gap=True):
    """在窗口内找首次触发；返回 (i, 形态)"""
    pc = x['pc']; P = x['P']; mid = x['mid']
    if need_gap and not (-2 <= x['gap'] <= 1.5):
        return None, None
    f5hi = max(P[:5])
    for i in range(5, len(P)):
        t = x['pts'][i][0]
        m = int(t[:2]) * 60 + int(t[2:])
        if m < W_LO: continue
        if m > W_HI: break
        p = P[i]
        if p < pc: continue                       # 此刻要在水上
        back_up = any(P[k] < pc for k in range(i))   # 之前跌破过
        brk_hi = p > f5hi
        if not (back_up or brk_hi): continue
        if need_mid and mid[i] < pc: continue
        if need_shrink:
            r = shrink_at(x, i, thr=shrink_thr)
            if r is None or r >= shrink_thr: continue
        if use_shake and not shake_ok(x, i): continue
        return i, ('翻上水面' if back_up else '过分时前高')
    return None, None


def run(label, **kw):
    gross, net, exg, forms = [], [], [], []
    for x in S:
        i, form = find_trigger(x, **kw)
        if i is None: continue
        buy = x['P'][i]
        g = (x['close'] / buy - 1) * 100
        gross.append(g); net.append(g - FEE)
        exg.append(g - BENCH[i] * 100)   # 毛对毛，口径一致
        forms.append(form)
    if not gross:
        print(f'{label:36s}    0 只'); return
    n = len(gross)
    m = sum(gross) / n; ne = sum(net) / n; e = sum(exg) / n
    sd = (sum((z - e) ** 2 for z in exg) / max(1, n - 1)) ** 0.5
    t = e / (sd / n ** 0.5) if sd > 0 else 0
    w = sum(1 for z in net if z > 0) / n * 100
    print(f'{label:34s}{n:6d} 只  毛{m:+6.2f}% 净{ne:+6.2f}% 胜{w:3.0f}% '
          f'超额{e:+7.3f}%(t={t:+5.2f})')


print('=' * 96)
run('① 全市场随便买（不看形态）', need_mid=False, need_shrink=False, need_gap=False)
run('② 只要开盘幅度 -2%~+1.5%', need_mid=False, need_shrink=False, need_gap=True)
run('③ ②+ 中在水上', need_mid=True, need_shrink=False)
run('④ ③+ 缩量(<0.8)', need_mid=True, need_shrink=True)
run('⑤ ④+ 震荡验证（你的完整条件）', need_mid=True, need_shrink=True, use_shake=True)
print()
run('⑥ 去掉中在水上', need_mid=False, need_shrink=True, use_shake=True)
run('⑦ 去掉缩量', need_mid=True, need_shrink=False, use_shake=True)
run('⑧ 去掉震荡验证', need_mid=True, need_shrink=True, use_shake=False)
run('⑨ 缩量门槛放宽 <1.0', need_mid=True, need_shrink=True, shrink_thr=1.0, use_shake=True)
run('⑩ 缩量门槛收紧 <0.6', need_mid=True, need_shrink=True, shrink_thr=0.6, use_shake=True)
print()

# 分触发形态
for tag, want in [('翻上水下→水上', 'back'), ('过分时前高', 'brk')]:
    gross, net, exg = [], [], []
    for x in S:
        i, form = find_trigger(x, need_mid=True, need_shrink=True, use_shake=True)
        if i is None: continue
        if want == 'back' and form != '翻上水面': continue
        if want == 'brk' and form != '过分时前高': continue
        buy = x['P'][i]
        g = (x['close'] / buy - 1) * 100
        gross.append(g); net.append(g - FEE); exg.append(g - BENCH[i] * 100)
    if gross:
        n = len(gross); m = sum(gross)/n; ne = sum(net)/n; e = sum(exg)/n
        sd = (sum((z-e)**2 for z in exg)/max(1,n-1))**0.5
        t = e/(sd/n**0.5) if sd > 0 else 0
        w = sum(1 for z in net if z > 0)/n*100
        print(f'{tag:32s}{n:6d} 只  毛{m:+6.2f}% 净{ne:+6.2f}% 胜{w:3.0f}% '
              f'超额{e:+7.3f}%(t={t:+5.2f})')

print('\n' + '=' * 96)
print('毛收益口径（不扣手续费），看策略本身有没有正向空间')
print('=' * 96)
for label, kw in [('你的完整条件', dict(need_mid=True, need_shrink=True, use_shake=True)),
                  ('中在水上+缩量', dict(need_mid=True, need_shrink=True)),
                  ('只要触发点+开盘幅度', dict(need_mid=False, need_shrink=False))]:
    gross, exg = [], []
    for x in S:
        i, _ = find_trigger(x, **kw)
        if i is None: continue
        buy = x['P'][i]
        r = (x['close'] / buy - 1) * 100
        gross.append(r); exg.append(r - BENCH[i] * 100)
    if gross:
        n = len(gross); m = sum(gross)/n; e = sum(exg)/n
        sd = (sum((z-e)**2 for z in exg)/max(1,n-1))**0.5
        t = e/(sd/n**0.5) if sd > 0 else 0
        w = sum(1 for z in gross if z > 0)/n*100
        print(f'{label:32s}{n:6d} 只  毛{m:+6.2f}%  胜{w:3.0f}%  超额{e:+7.3f}%(t={t:+5.2f})')
