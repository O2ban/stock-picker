---
id: memory-565
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T06:58:40+08:00
updated: 2026-10-21T06:58:40+08:00
importance: high
category: 方法经验
keywords: [TIMELINE_SLOTS, 整点竖线槽位, HOUR_LINES, 11:30午休分界, 10:00亮线, markLine合并]
summary: stock-picker 分时整点竖线的槽位推算与 markLine 合并方案：以 09:30 为槽 0 生成 242 个槽位，10:00=30、10:30=60、11:30=120、14:00=181，刻意不含 13:00 以避免与 11:30 视觉重叠，且昨收线与整点线合并进同一 markLine data 数组。
---
分时图整点竖线实现要点：TIMELINE_SLOTS 从 push(9,30,11,30) 生成 0~120（121 槽），再 push(13,0,15,0) 生成 121~241（121 槽），共 242 槽。槽位索引对应 '1000'=30、'1030'=60、'1130'=120、'1300'=121、'1400'=181、'1500'=241。HOUR_LINES 列表刻意不含 '1300'，因为 11:30(120) 与 13:00(121) 仅差一个槽，两条线视觉几乎重合，作者用 11:30 作为唯一午休分界竖线。10:00 单独用 rgba(255,255,255,.13) 略亮以突出。ECharts 一个 series 只允许一个 markLine，所以昨收线（yAxis: prevClose）与 HOUR_LINES 必须合并进同一 data 数组；无昨收时 data 只剩 HOUR_LINES，按 yAxis 缺省推断为竖线，不会留下空 markLine。每条整点线的 lineStyle.type:'solid' 会覆盖外层 markLine 的 dashed，昨收/y=1/y=3 保留 dashed。
