---
id: memory-023
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-01T19:02:35+08:00
updated: 2026-10-01T19:02:35+08:00
importance: medium
category: 其他
keywords: [stock-picker, volume-ratio-caliber, tdx-difference, volume-averaging, denominator-inclusion, subtle-bug]
summary: stock-picker 预计算表的量比口径与通达信存在细微差异需慎重：库里的 vr 分母是'前 N 天均量（不含当天）'，通达信用的是'含当天的 N 天均量'，两者会导致量比筛选结果在临界值（如 1.2）附近翻转；且库里只存了量比结果未存均量分母，展示详情时无法还原原始均量值。
---
具体差异：库里 vr20 = 当日成交量 / (前20日成交量之和/20)，通达信 vr20 = 当日成交量 / (含当日的20日均量)——后者分母里多含了当天自己所以值会略小。默认策略卡在'量比≥1.2'这个门槛上，这个细微差别会让少量临界票在两边结果不同。当前处理方式：直接用库里的量比做筛选（口径与通达信不完全一致但接受此差异），另按原算法从成交量列滑动平均计算均量做展示用（因为库里没存分母）。后续若用户反馈'和通达信结果对不上'，此处是首要排查点。
