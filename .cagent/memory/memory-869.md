---
id: memory-869
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T12:54:57+08:00
updated: 2026-11-22T12:54:57+08:00
importance: medium
category: 代码逻辑
keywords: [rv-plans.json, 100天高昨比, 全市场扫描, 指标注入, 证据数据, stock-picker, rv.js]
summary: 100天平均高昨比和100天内高昨比>1%占比两个指标由全市场扫描脚本算出后单独注入rv-plans.json，不能从证据数据推导，因为证据数据只覆盖买入日。
---
stock-picker复盘页新增的「100天平均高昨比」和「100天内高昨比>1%占比」两个指标：数据来源是全市场扫描脚本（与策略买入日判断同口径），而非复盘页的证据数据JSON——证据数据只覆盖买入当日，不含最近100天完整窗口。因此这两个指标需在扫描阶段算好后写入rv-plans.json的股票字段，再由rv.js在指标行读取展示。口径为hpr=(当日最高/昨收−1)×100，与策略买入日判断和K线脚本完全一致（已用首笔2026-06-25：hi=91/pc=89.49→1.5187%逐位核对）。
