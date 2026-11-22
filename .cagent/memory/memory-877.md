---
id: memory-877
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T15:35:33+08:00
updated: 2026-11-22T15:35:33+08:00
importance: medium
category: 代码逻辑
keywords: [浮层, fixed定位, 屏幕坐标, rect基准, 撑满屏宽, stock-picker]
summary: 分时浮层要从相对主图容器定位改为fixed相对视口定位才能撑满屏幕宽；但主图回调传来的rect是相对画布坐标，两者基准不同会错位，rect只做垂直参考、缺省时给安全默认值。
---
分时浮层原本被关在主图容器里（position:absolute相对父级），所以天生离屏幕有距离。改为position:fixed相对视口定位后可撑满整屏宽度。但坐标来源需理清：主图回调传出的rect是相对主图画布的坐标，而浮层现在fixed相对视口，两者基准不同会错位。解决方案：rect只做垂直参考（确定浮层放在主图下方哪个位置），水平方向直接撑满屏幕宽，缺省时给安全默认值。
