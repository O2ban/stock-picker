---
id: memory-872
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T13:34:08+08:00
updated: 2026-11-22T13:34:08+08:00
importance: high
category: 代码逻辑
keywords: [重算引擎, 止盈优先, 逐分钟扫描, 止损模式, 前端回测, stock-picker, 复盘页]
summary: 前端重算引擎采用「止盈优先」原则：逐分钟扫描T1数据，先检查收盘价是否≥买入价×(1+tp%)触发止盈；未触发时再根据止损模式（固定百分比按分钟收盘判定/收盘价止损按T1收盘判定）决定止损或持仓到收盘。
---
重算引擎recomputeEngine(params)的核心逻辑：遍历D.all全部100笔，gates非空的笔标记bought=false不计入；买入价=该笔buy（T日15:00收盘）；T1逐分钟扫描（09:31→15:00）按「止盈优先」原则：1）止盈：收盘价≥buy×(1+tp%)即触发，按该分钟收盘价成交；2）固定百分比止损：止盈未触发时检查收盘价≤buy×(1+sl%)；3）收盘价止损：止盈未触发时看T1收盘，若跌幅≤stopPct按收盘卖，否则按原止盈逻辑；4）全天未触发→T1收盘卖。gross=(卖出价/buy-1)×100，net=gross-0.083（双边费用）。汇总仅买入笔：n/win/avgWin/avgLoss/mean/med/cum（复利连乘）/b=|avgWin/avgLoss|/凯利f=(p·b-q)/b。
