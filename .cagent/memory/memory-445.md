---
id: memory-445
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T08:32:55+08:00
updated: 2026-10-20T08:32:55+08:00
importance: medium
category: 方法经验
keywords: [分时图图例, renderTimelineLegend, 公式线图例, 副图图例错位]
summary: 分时图的图例按副图分行渲染时，公式线（中/PP/HH/M20）必须出现在价格图那一行，否则会漏项或串到量比副图那行。
---
stock-picker 的 renderTimelineLegend 按图分行生成图例时容易出错：价格图图例行只列了「价格/均价/涨跌」而漏掉四條公式曲线，「中」「M20」的当前值反而被塞进量比副图那一行。新增或修改主图曲线时必须同步把对应名称和当前值注册到价格图图例行，不要随副图行一起渲染。
