---
id: memory-454
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T09:27:23+08:00
updated: 2026-10-20T09:27:23+08:00
importance: medium
category: 方法经验
keywords: [纵轴, 昨收中轴对称, DefaultSplit, HQChart, 贴边不留余量]
summary: 分时图纵轴应采用通达信口径的昨收中轴对称（d=max(|hi-昨收|,|昨收-lo|)，min=昨收-d、max=昨收+d，刻度固定4格），与 HQChart 的 DefaultSplit 算法一致，而非满占坐标。
---
分时纵轴的最终实现口径：放弃满占坐标，改用与 HQChart DefaultSplit 一致的算法——d = max(|hi − 昨收|, |昨收 − lo|)，min = 昨收 − d、max = 昨收 + d，曲线贴边不留余量，幅度完全跟随当日真实偏离，刻度固定 4 格。效果是昨收虚线正落在正中、价格线上下对称展开，即通达信的样子。注意此口径下跳空票会有半区留白属正常表现，且接入实时价时要实时比对极值越界重绘并加节流。
