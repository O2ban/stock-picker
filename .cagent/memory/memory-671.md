---
id: memory-671
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T11:49:40+08:00
updated: 2026-11-19T12:58:40+08:00
importance: low
category: 方法经验
keywords: [清单排序, 实时涨幅, 全量拉取, 两批请求, stock-picker]
summary: 清单仅一百多只时全部拉取实时行情只需两批请求，可行地支持按实时涨幅排序并随行情刷新自动重排。
---
修复清单排序错乱（排序用出手时涨幅、显示用实时涨幅）的方案：清单规模只有一百多只，全量拉取实时行情仅需两批分批请求，因此可以做到当天清单按实时涨幅排序，并在行情刷新时自动重排；同时需注意每批请求只取当前可视/范围内股票，避免 URL 过长。
