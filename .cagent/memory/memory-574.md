---
id: memory-574
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T14:14:16+08:00
updated: 2026-10-21T14:14:16+08:00
importance: medium
category: 方法经验
keywords: [stock-picker, code-format, normalizeCode, prefixed-code, 行情校验, guard-dependency]
summary: stock-picker 中行情 code 与图表 state.code 均统一为小写带市场前缀格式（如 sz000807），这是新增 q.code !== state.code 严格校验能成立的前提；若未来新入口塞入裸码会导致该票行情被全部丢弃。
---
stock-picker 中行情 code 与图表 state.code 均统一为小写带市场前缀格式（如 sz000807），这是新增 q.code !== state.code 校验能成立的前提。

- 实时行情 q.code 来自 src/quotes.js 的 parseQuotes，正则 v_([a-z]{2}\d{6}) 提取后再经 normalizeCode 统一为小写带前缀。
- state.code / nb.code 来自 DB stocks 表，实测 5574 条全部为小写且匹配 ^[a-z]{2}\d{6}$，无大写、无裸码。
- 因此 !== 对比在常态下恒相等，不会误伤正常行情；行情对象不带 code 时短路放行（宁可更新也不饿死）。

注意：该防护的正确性依赖两者格式一致。若未来新增数据通道（搜索、外部自选导入）塞入裸码 000807，会与 sz000807 判不等，把该票行情全部丢弃，表现为“这只票行情不刷新”。长期建议在 setNeighbors/open 入口统一 normalizeCode 兜底。
