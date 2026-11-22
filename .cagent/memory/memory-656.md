---
id: memory-656
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-21T23:25:36+08:00
importance: medium
category: 方法经验
keywords: [日K点击日期, 分时弹层, 图表坐标对接, 副图区, stock-picker]
summary: 日K图点击日期标签弹出分时图时，需把几何位置信息从 chart.js 传出去，并确认图表布局与像素坐标的对接方式，才能让浮层准确落在副图区。
---
在日K图上点击某个日期打开当日分时的交互，实现要点是：chart.js 对点击日期标签只做最小改动——把命中的几何位置信息传递出去；浮层的定位要靠图表布局与实际像素坐标对接（副图区位置），否则浮层会落错位置。多买点标注接入时也应复用分时图构建逻辑而非另写一套。
