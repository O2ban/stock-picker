---
id: memory-867
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T12:21:12+08:00
updated: 2026-11-22T12:21:12+08:00
importance: low
category: 代码逻辑
keywords: [复盘页, 指标行, stock-row, 虚拟滚动, 纵向布局, rv.js]
summary: 复盘列表每只股票下方新增指标行，方案样本极少时关闭虚拟滚动并改纵向布局。
---
stock-picker 复盘页 rv.js 的股票行模板改造：每只股票行下方增加指标行，展示胜率、平均盈利、平均亏损、预期每笔、实际累计、交易笔数（均含 0.083% 双边费用实算）。因指标行高度不定且方案样本极少（各方案仅 1 只），关闭了虚拟滚动；同时把复盘列表的 stock-row 从横向 flex 改为纵向排列，行主体包进 .sr-main 容器，指标块独占一行。
