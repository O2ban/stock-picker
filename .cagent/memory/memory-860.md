---
id: memory-860
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T09:46:26+08:00
updated: 2026-11-22T09:46:26+08:00
importance: high
category: 工具资源
keywords: [A股, 1分钟OHLC, 数据源对比, 麦蕊智数, 智兔数服, 金数源, tushare, 北交所, 历史分钟数据, 选型结论]
summary: A股历史1分钟OHLC数据源选型完整对比：麦蕊智数是唯一同时满足长历史+北交所+分钟OHLC且文档可查的源，通达信lc1+金数源历史最长但无北交所，tushare正规但北交所未明确。
---
经逐项核实，能同时满足「分钟内高低价+长历史+沪深京」且文档可查的数据源：①麦蕊智数Quant Pro（888元/年）——唯一全条件命中，沪深主流标的可回溯约1991年，明确含京市/北交所，字段有OHLC+量+额+前收，官方文档清晰，但当年数据每月才更新1次，批量拉全市场需自己按年份分批；②智兔数服——唯一把北交所Pro历史1分钟写进公开端点清单（/bj/pro/history/{code}.BJ/1/n），有免费额度可先验证，但宣称30年+未给精确起年，Pro版价格不公开；③通达信lc1+金数源（1999.08起按年买）——格式最干净（真三价+真OHLC、可离线、零限频），历史最长，但没有北交所，价格不公开需询价，属个人小作坊需自己抽样对账；④tushare stk_mins（2000元/年）——正规、2010年起、文档明确、有pre_close，但北交所未写明，单次8000行需自己循环。明确排除：akshare（1分钟只有近5-9个交易日）、baostock（无1分钟线且不支持北交所）。其他付费源：BigQuant bar1m（2005起，带adjust_factor）、rqdatac（2005起但明确无BSE）、jqdatasdk（2005起）、掘金myQuant（10年）、QMT/xtquant（券商版实测被限1年）。
