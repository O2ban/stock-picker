---
id: memory-057
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T14:26:45+08:00
updated: 2026-10-19T14:26:45+08:00
importance: medium
category: 其他
keywords: [stock-picker, 非交易时段, 实时K线, 交易时段守卫, state.quote, 开仓重置, 换股串行情]
summary: stock-picker 新增非交易时段（含非交易日）不更新实时行情的守卫，涉及 chart.js 实时合并与 app.js 两处，且 state.quote 必须在开仓时重置，否则换股会把上一只的行情叠加进来。
---
stock-picker 为「非交易时段（含非交易日）不更新」这一需求要做两处改动：chart.js 的实时合并守卫、app.js 的同步处理。同时必须把 state.quote 加入开仓时的重置列表——它属于跨股票残留状态，不清理会把上一只股票的实时行情叠加到新打开的股票上，表现为图形污染。此类「按当前标的重置行情状态」的点在 stock-picker 中已多次踩坑（如 tdx:switch 路径不回填、快速横滑串票），换股/开仓路径应统一走同一套状态清理。
