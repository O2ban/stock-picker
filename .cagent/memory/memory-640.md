---
id: memory-640
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: high
category: 错误教训
keywords: [快照失败, 分时退化, lastBucket占格, 自动盯盘, 整天清单为空]
summary: 行情快照整批失败时，选股结果全部因 noQuote 被跳过变为0条，而 autoWatchStatus 又先把 lastBucket 占住导致该时间格不重试，早盘第一次自动盯盘撞上上游抖动就会整天清单为空。
---
H2 缺陷：intraday.js 中 fetchQuotes 抛错后 quoteMap 为空，universe 循环里每只都 noQuote++ 被跳过，本次选股 0 条；intraday-picks.js 的 autoWatchStatus 又把 lastBucket 先占住，当格不再补跑。影响是早盘第一次自动盯盘撞上游抖动即整天清单为空。修法方向：快照失败时退化为「逐只拉分时后自行算开盘幅度」，或失败时不占格。
