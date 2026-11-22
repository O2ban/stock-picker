---
id: memory-038
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T08:45:20+08:00
updated: 2026-10-19T12:41:50+08:00
importance: medium
category: 其他
keywords: [stock-picker, 实时价, tdx:switch, switch-stock, applyQuote, cache-override, 换股回填, 行情叠加]
summary: stock-picker 横滑换股走 tdx:switch 路径不会回填行情导致主图无最新价，修复需把换股路径做成与 openChart 一致的两步叠加，并加丢弃检查防止快速横滑串票。
---
stock-picker 中「点进列表」有实时价、横滑换股后实时价消失的根因是两条路径不一致：openChart 会主动把行情并进 K 线，而 tdx:switch 只更新标题和高亮邻票，从不回填行情；同时 api.load() 会用缓存/回源数据整体替换 klines，所以即便之前并进去过，滑走再滑回来也会被冲掉。

修法：换股路径改成与打开时一致——先用缓存里的行情叠加一次，再单独拉这一只的行情，回来后叠加第二次；并加「这期间用户又滑到别的票就直接丢弃结果」的检查，避免快速连续横滑时旧股票的行情被串进新图。

关联约束（memory-036）：周线/月线不叠加实时价是有意设计，不是本次要修的点。
