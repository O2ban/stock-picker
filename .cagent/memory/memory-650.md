---
id: memory-650
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 方法经验
keywords: [节假日, 只判周末, 全市场分时拉取, 白跑, 廉价快照探测]
summary: 自动盯盘只判周末不判节假日，节假日窗口内每格仍先做一次全市场分时拉取（约20-40秒、数千次上游请求），到 runPickOnce 才以 not-trading-day 拒绝，属每天白跑4轮。
---
M8：intraday-picks.js 只判周末不判节假日。窗口内每格都会先做一次全市场分时拉取（约20–40秒、数千次上游请求），到 runPickOnce 才以 not-trading-day 拒绝。功能安全但浪费严重，建议先做一次廉价快照探测再决定是否拉全市场。
