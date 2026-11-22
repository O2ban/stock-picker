---
id: memory-555
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T20:26:28+08:00
updated: 2026-10-20T20:26:28+08:00
importance: medium
category: 方法经验
keywords: [echarts, 端点刻度, 标签外溢, DOM覆盖层, 量比轴, 分时副图]
summary: ECharts 的轴端点刻度标签默认按刻度位置居中外伸，必然会压到面板框外的图例或时间标签，改用 DOM 覆盖层在面板内侧自绘刻度数字可完全控制位置。
---
在 stock-picker 量比副图上，ECharts 轴的最小/最大刻度标签是按刻度位置居中对齐的，所以首尾数字总有一半伸到面板框线之外：顶端数字被「量比」图例行压住，底端数字贴到时间标签。这不是靠 padding 或 label 偏移能稳定解决的。有效做法是关闭 ECharts 的轴标签（不再走 axisLabel），改为在面板内侧用 DOM 覆盖层自绘这两个极值数字，位置可精确控制到面板内部任意像素。同一思路适用于任何「只保留首尾极值、不允许溢出」的副图轴标注场景。
