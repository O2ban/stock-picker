---
id: memory-052
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T13:05:44+08:00
updated: 2026-10-19T13:05:44+08:00
importance: high
category: 其他
keywords: [REALTIME_PRICE_MAP, realtime-quote-selection, volume-ratio-intraday, baseDate-consistency, look-ahead-bias, halts-fake-kline, weekly-rt-bar-exclusion]
summary: stock-picker 当日选股未接实时价的根因是 REALTIME_PRICE_MAP 环境变量从未被赋值，修复时连带需处理四个缺陷：盘中量比折算、停牌/节假日假 K 线、周线混入盘中量、baseDate 与实时价口径矛盾。
---
用户问『先拉最新股价再选股是否更快』，实测：全市场 5373 只拉一次实时行情 3.3s（腾讯源，90 批并发），原选股 13.6s，加实时价后首次约 15.5s、缓存热后 1.6~2.4s——慢约 24% 但这 3 秒是正确性成本，不拉等于盘中选的是上一交易日收盘的答案。修复必须成组处理（否则修一个坏一个）：(1) 价格来源从空转的环境变量改为请求传入的批量行情表；(2) 盘中量比按标准口径『累计量 ÷ (均量 × 已开盘时间占比)』折算，收盘后占比=1 自动退化保持历史一致；(3) 补今日 K 线的硬门槛必须是『行情快照日期=今天 且 成交量>0』，否则停牌股（拿昨收顶替、量给 0）和工作日节假日（全市场 5000+ 只被补假 K 线）会造出不存在交易日；(4) 补入的实时 bar 打标记，拼周线和日线聚合周线时一律剔除，避免半日量÷整周均量导致周线量比系统性偏低；(5) baseDate 的判定要和『是否补今日实时价』用同一个判断，否则显示基准日 10-16 但价格是今天的。展示层量比的均量分母也要与 ratio 真实分母对齐（不含当日、已折算）。历史基准日回测已验证不混入今日价。笔记 notes/realtime-price-selection.md。遗留风险：沪深/北交所部分板块成交量单位可能是『手』，若量比整体偏大或偏小 100 倍需回查。
