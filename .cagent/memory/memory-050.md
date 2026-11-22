---
id: memory-050
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T12:41:50+08:00
updated: 2026-10-19T12:41:50+08:00
importance: low
category: 其他
keywords: [stock-picker, 横滑边界, 最后一只, 无法滑动, 非bug]
summary: stock-picker 排序后打开列表末尾的股票时横滑不动是正常行为（没有下一只），不属于 bug。
---
stock-picker 中若打开的股票在排序后落在列表末尾，横滑无法继续是预期行为，没有下一只可切换。测试与给用户解释时不应把它当成缺陷；用例应选打开中间一只股票来验证横滑落点。
