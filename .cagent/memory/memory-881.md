---
id: memory-881
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T16:36:15+08:00
updated: 2026-11-22T16:36:15+08:00
importance: medium
category: 代码逻辑
keywords: [分时浮层, 定位方案, 主图下沿, 副图遮挡, gridRects, 用户底线, stock-picker]
summary: stock-picker 看盘抽屉分时浮层的最终定位方案：浮层贴屏幕底、上沿卡主图价格区下沿只盖副图，用户明确否决『腾空挤压日K』方案
---
用户底线：分时浮层可以盖住副图（量能/振幅带），但绝不能盖住日K主图的价格走势，也不能通过给日K腾空来挤压主图看图空间——曾尝试给 #chart-canvas 加 margin-bottom 让主图靠 ResizeObserver 自动上移让位的方案，被用户直接否决并要求撤掉。最终实现：浮层保持 position:fixed 贴屏幕底边、左右撑满屏宽，通过主图新暴露的 gridRects() 接口读取价格区（主图）在屏幕上的下沿坐标，浮层 top 设为主图下沿，正好只覆盖下方副图区域。已清除 hideSubmin 里残留的撤腾空代码，关闭浮层不再需要额外清理。主图 gridRects 是内部状态，对外暴露需在主图 api 里加读取方法。
