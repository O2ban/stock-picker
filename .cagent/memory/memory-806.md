---
id: memory-806
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T23:18:27+08:00
updated: 2026-11-21T15:31:58+08:00
importance: medium
category: 用户习惯与关切
keywords: [stock-picker, 参数调优, 事后调参, 不能当有效性证据]
summary: 用户认可：放宽参数后跑出的收益绝不能当作策略有效性的证据，因为参数是事后调的，只能用于调试看信号形态。
---
在 stock-picker 分时策略的讨论中确立了口径：拿历史某天放宽参数再跑，只能当调试用——看信号长什么样、买点落在什么位置；不能拿这个当策略有效性的证据，因为参数是事后按该天结果调的，收益一定是假的。汇报时必须显式区分「调试观察」与「有效性验证」。
