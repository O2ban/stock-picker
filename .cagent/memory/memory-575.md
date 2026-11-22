---
id: memory-575
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T21:22:11+08:00
updated: 2026-10-21T22:43:42+08:00
importance: medium
category: 方法经验
keywords: [指标区占位, 换股抖动, 布局稳定, canvas-measureText, stock-picker]
summary: 换股时顶部指标区会先「缩」掉一两行再「撑」开导致图表整体上跳，修法是无论有无数据都先按固定字段排版、缺值显示短横线，且占位宽度按偏保守的典型数值宽度计算。
---
stock-picker 换到新股票、数据未回来时，那一排指标会先塌掉一两行，数据到了再撑开，图表整体往上一跳。修复：不管有没有数据先按固定字段把行排好，没值的显示短横线，数据回来只是把横线换成数字、行数不变。注意占位宽度必须按偏保守的典型数值宽度算（用 canvas measureText），否则占位与真实数据算出不同行数、高度照样跳。实测慢网络下反复换股高度稳定。
