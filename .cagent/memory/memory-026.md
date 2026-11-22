---
id: memory-026
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-06T17:33:04+08:00
updated: 2026-10-06T17:33:04+08:00
importance: high
category: 其他
keywords: [date-index, daily_indicators, full-table-scan, IN-query, performance, stock-picker, query-rewrite]
summary: stock-picker性能优化最大单点突破：daily_indicators表加idx_di_date索引并将查询从WHERE code IN(5574个code)改为WHERE date范围查询，DB查询从17秒降到0.01秒。
---
daily_indicators表PK是(code,date)，原loadIndicators用WHERE code IN(5574个?)查询，数据库需逐个code在B-tree中定位，且没有date索引导致即使只按日期查也全表扫描942万行。加idx_di_date(date)和idx_di_date_code(date,code)两个索引后，改为WHERE date>=? AND date<=?一条SQL查完全市场所有票，走索引直接定位日期范围。实测：SQL查询从17秒降到0.01秒。整个优化路径：33.7s(旧版每票5次loadRows)→13.8s(每票1次)→10s(加date索引+改查询)→3s(calcNeedDays减少取数天数)。这是整个优化中最大单点收益的改动。
