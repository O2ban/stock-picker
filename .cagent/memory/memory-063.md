---
id: memory-063
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T18:51:24+08:00
updated: 2026-10-19T18:51:24+08:00
importance: low
category: 其他
keywords: [stock-picker, 交易时段守卫, inTradingWindow, setTimeout轮询, refreshQuotes, 交互触发刷新, 非交易时段空转]
summary: stock-picker 行情刷新的定时轮询受 inTradingWindow()（9:15-11:30 / 13:00-15:05）守卫只交易时段运行，但 refreshQuotes() 在 8 处交互点（切tab/换股/加自选/页面可见/focus 等）直接调用不受时段限制，这是刻意设计——收盘后用户主动打开页面应看到当天收盘价而非旧缓存。
---
stock-picker 的实时行情刷新有两类来源：A. setTimeout 驱动的 60 秒定时轮询，受 inTradingWindow() 交易时段守卫（9:15-11:30 / 13:00-15:05）限制；B. 交互触发的即时刷新，refreshQuotes() 在 app.js 约 8 处被直接调用（切tab、滑图换股、加自选、页面重新可见、窗口 focus），不受时段闸限制。B 类不受限是合理设计——用户主动操作时就该看到最新价。排查『非交易时段还在打上游』的误判：需区分是否是改版前旧版 app.js（无时段守卫）留下的日志残留，而非当前代码空转。『每分钟』的准确边界是：交易时段内 + 页面可见 + 未被判定休市，三者同时成立才每分钟一拉，其余请求都是人手触发的。
