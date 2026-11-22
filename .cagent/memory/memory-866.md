---
id: memory-866
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T12:21:12+08:00
updated: 2026-11-22T12:21:12+08:00
importance: medium
category: 代码逻辑
keywords: [回测方案, 出场规则, 次日盘中触价, 止盈卖出, stock-picker]
summary: 回测方案「次日开盘卖」命名不准，真实规则是次日盘中任一分钟触到止盈价即卖、仅跳空高开才按开盘价成交。
---
stock-picker 复盘方案的出场规则实际语义：次日盘中任一分钟触及 +1% 即按该价卖出，只有跳空高开超过 +1% 时才按开盘价成交。此前标注为「次日开盘卖」是错误命名，已改为「次日盘中触价卖」。在规则文案与代码注释中涉及此方案时必须使用准确口径，否则用户会误解为固定开盘卖出。
