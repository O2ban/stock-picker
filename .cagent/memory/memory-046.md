---
id: memory-046
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T23:58:09+08:00
updated: 2026-10-15T23:58:09+08:00
importance: low
category: 其他
keywords: [applyRealtimeToDaily, REALTIME_PRICE_MAP, no-op, 死代码, stock-picker, 盘中补齐, kline]
summary: stock-picker 后端 applyRealtimeToDaily 依赖的 REALTIME_PRICE_MAP 从未被任何代码填充，该『盘中实时补齐』函数实为 no-op，排查盘中K线补齐问题时应知道这条后端路径是死的。
---
stock-picker/kline 后端存在 applyRealtimeToDaily，读取模块级 REALTIME_PRICE_MAP 来把实时价合并进日线末根，但 REALTIME_PRICE_MAP 在全代码库中只有读取、没有任何写入点，因此该函数实际上永远不生效(no-op)。盘中实时价目前实际由前端链路承担(/api/quotes 轮询 + 前端 applyQuote 合成)。排查『盘中K线没补齐』时不要误以为后端 applyRealtimeToDaily 在起作用，它是死代码。
