---
id: memory-055
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T13:42:15+08:00
updated: 2026-10-20T00:34:15+08:00
importance: medium
category: 代码逻辑
keywords: [分时十字线, canvas偏移, clientY, 坐标转换, 纵向拖动]
summary: 分时图十字线纵向拖动必须把 clientY 减去画布顶部偏移转成画布内坐标，直接用视口坐标会导致位移放大数倍并撞底。
---
分时图十字线（点击唤出、横向拖动换分钟、纵向滑动移动横线）里曾出现「手指动 60px 横线跳 194px 且撞到底部」的现象，根因是纵向拖动直接用了 e.clientY（视口坐标），而网格矩形和横线定位用的是画布内坐标，未减去画布顶部偏移。修复后 60px 输入对应 60px 位移。任何在 canvas 上做手势的实现都要先做这一层视口→画布坐标转换。
