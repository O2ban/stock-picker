"""从 bt.json 派生「回测方案」清单给复盘页下拉用。
只做分组与求和，不重算任何收益：net 已含双边费用。
输出 public/rv-plans.json。"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.abspath(os.path.join(HERE, '../../../public'))

b = json.load(open(os.path.join(HERE, 'bt.json')))
fee = b['fee']
trades = b['trades']
alls = b['all']


def summarize(rows):
    n = len(rows)
    if not n:
        return {'n': 0, 'mean': 0.0, 'med': 0.0, 'win': 0.0, 'cum': 0.0}
    nets = sorted(r['net'] for r in rows)
    mean = sum(nets) / n
    med = nets[n // 2] if n % 2 else (nets[n // 2 - 1] + nets[n // 2]) / 2
    win = sum(1 for v in nets if v > 0) / n * 100
    cum = 1.0
    for r in rows:
        cum *= (1 + r['net'] / 100)
    return {
        'n': n,
        'mean': round(mean, 4),
        'med': round(med, 4),
        'win': round(win, 2),
        'cum': round((cum - 1) * 100, 4),
    }


NAME = '常友科技'
CODE = 'sz301557'

plans = [
    {
        'id': 'filtered',
        'name': '双过滤 · 1% 止盈 · 次日开盘卖',
        'note': '买入日高昨比 ≥ 1% 且收盘不跌破 MA5/MA20 才买；次日任一分钟最高触到 +1% 即卖，'
                '09:31 已高于触发价按开盘价成交，全天未触及按收盘价卖出。',
        'stocks': [dict(code=CODE, name=NAME, **summarize(trades))],
    },
    {
        'id': 'nofilter',
        'name': '对照 · 不加任何过滤',
        'note': '同样的买卖规则，但不看高昨比也不看均线，全部候选都买入，用来看过滤条件到底挡掉了什么。',
        'stocks': [dict(code=CODE, name=NAME, **summarize(alls))],
    },
    {
        'id': 'target',
        'name': '对照 · 只看止盈成功的那批',
        'note': '把当天就触到 +1% 卖出、以及开盘跳空高开卖出的两类合在一起，代表这套规则的上限。',
        'stocks': [dict(code=CODE, name=NAME,
                        **summarize([r for r in alls if r['kind'] in ('TARGET', 'OPEN_GAP')]))],
    },
    {
        'id': 'nohit',
        'name': '对照 · 一天没冲到 +1% 的那批',
        'note': '全天最高价都没触到 +1%，最后只能在收盘卖出的那批，是这套规则亏钱的主要来源。',
        'stocks': [dict(code=CODE, name=NAME,
                        **summarize([r for r in alls if r['kind'] == 'NOHIT_CLOSE']))],
    },
]

out = {'fee': fee, 'updatedAt': '2026-11-21', 'plans': plans}
p = os.path.join(PUB, 'rv-plans.json')
open(p, 'w').write(json.dumps(out, separators=(',', ':'), ensure_ascii=False))
print('wrote', p, os.path.getsize(p), 'bytes', 'fee', fee)
for pl in plans:
    s = pl['stocks'][0]
    print(f"  {pl['id']:<9} n={s['n']:<4} mean={s['mean']:+.4f} med={s['med']:+.4f} win={s['win']:.1f}% cum={s['cum']:+.3f}")
