---
id: memory-035
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T07:48:12+08:00
updated: 2026-10-15T07:48:12+08:00
importance: medium
category: 其他
keywords: [stock-picker, mini-kline, canvas-vs-echarts, 列表性能, sparkline]
summary: stock-picker 自选列表的迷你 K 线用 canvas 手绘而非 ECharts，因为列表内挂多个图表实例会拖慢滚动。
---
stock-picker 列表行的迷你 K 线（40 根、最新价橙色虚线、无交互）采用纯 canvas 手绘实现（public/spark.js），不使用 ECharts。理由：自选/结果列表有几十行，若每行挂一个 ECharts 实例会显著拖慢滚动性能。迷你图仅作查看用途，不需要交互或点击效果；点击股票单行的行为始终是进入看盘界面。这是一个可复用的选型原则：列表内嵌微型图表应用 canvas 手绘代替重型图表库。
