---
id: memory-583
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T19:12:14+08:00
updated: 2026-10-23T20:03:45+08:00
importance: high
category: 方法经验
keywords: [prefilter, conditionNeedBars, evaluateConditions, 短窗预筛, unknown放行, 通用漏斗, low-suck-v2, 一致性验证]
summary: stock-picker 选股预筛漏斗已在 low-suck-v2 上落地验证：15 个 day 条件中 8 条浅条件（need≤10）先用短窗数据淘汰 5373→460，100 只结果及排名与关闭预筛完全一致，热态 3029→1215ms。
---
预筛漏斗实现要点与验收结论：
- engine.js 新增 conditionNeedBars（expr 条件 +1，非 expr 用参数 max+2 保守估算）与 evaluateConditions，rows.length<need 一律标 unknown 放行，只有明确 pass=false 才短路淘汰。
- db.js 新增 loadShortDaily：先 SELECT DISTINCT date LIMIT N 找真实最近 N 个交易日，再按 date>=? AND date<=? 走 idx_kline_date，不用 5574 参数的 IN。
- server.js 在拉实时行情之后、分批扫描之前插入预筛阶段，与完整扫描共用同一个 applyRealtimeToDaily 和 quoteMap，保证数据口径一致；预筛只影响 scanStocks 输入集合，不参与结果计算。
- 实测 low-suck-v2：5373 只淘汰 4913（91.4%），460 只进入第二阶段；冷/热 × 开/关 4 组运行 100 只 code 集合与 rank 顺序完全一致；热态 3029→1215ms，冷态约 15s→1.3s。
- 退化路径正常：只有周线条件或条件全是深回溯时，漏斗自动失效退回原逻辑。
- 已知遗留：server 的 POST /api/screenings 原先忽略 body.strategyId 只用 starter，已修为 body.strategy || strategies.get(body.strategyId) || strategies.get('starter')。
