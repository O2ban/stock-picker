---
id: memory-061
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T14:26:45+08:00
updated: 2026-10-19T14:26:45+08:00
importance: low
category: 其他
keywords: [verify_final, mismatch, 盘中价格跳动, 快照噪声, 区间复核, 不必追]
summary: verify_final 报告的 mismatch（sh601339 7.69 vs 7.68 等）是盘中两次快照间价格跳了一分钱造成的噪声，不是口径错误，无需追查。
---
stock-picker 的 verify_final.mjs 在盘中做「选股结果 vs 行情快照」比对时会报出 mismatch，典型如 sh601339 结果 7.69 对行情 7.68。根因是两次快照之间价格跳动了一分钱。此前已用「选股前后各拉一次行情、看结果是否落在区间内」的方式复核过，结果确实落在区间里。结论：盘中做这类数值比对必然产生一分钱级别的噪声，不要当成口径错误去追。
