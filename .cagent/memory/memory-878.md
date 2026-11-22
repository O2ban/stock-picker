---
id: memory-878
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T15:35:33+08:00
updated: 2026-11-22T15:35:33+08:00
importance: low
category: 错误教训
keywords: [十字线, 显隐, 横线竖线, tooltip, axisPointer, ECharts, stock-picker]
summary: 分时图十字线显隐切换时只关tooltip不够，横线（crossStyle）不会被关掉，必须同时切横竖线和两个轴标签才完整。
---
ECharts分时图十字线用axisPointer:cross实现（自带横竖两条线+标签）。点击显隐切换时，之前只切了tooltip的show，横线没跟着关，导致出现关掉一半的情况。正确做法是同时控制横竖线本身和两侧轴标签的显隐，保证整套十字线（横线+竖线+轴标签+提示框）一起出现或一起消失。
