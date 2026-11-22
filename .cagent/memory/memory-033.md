---
id: memory-033
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-14T23:42:35+08:00
updated: 2026-10-14T23:42:35+08:00
importance: medium
category: 其他
keywords: [stock-picker, 换股性能, setOption渲染瓶颈, 缓存, 双画布预渲染, 跟手滑入, TdxChart, prefetch, 测速误判]
summary: stock-picker 换股体感卡的瓶颈不是 K 线加载（缓存已命中，fetch≈0ms），而是 ECharts setOption 渲染 20-27ms，用双画布预渲染邻票+跟手滑入解决。
---
stock-picker 看盘换股的实测结论（CDP）：命中缓存时单次换股 18-33ms，其中 setOption 渲染 20-27ms，网络 fetch ≈0ms。缓存机制确实已做——TdxChart.prefetch 在结果渲染后批量预取，内存 Map + IndexedDB 双层，TTL 3 天。所以「加载股票费时」的假设不成立，卡的是渲染+动画编排（原实现松手先复位再播 260ms 滑入，滑动中看不到新图）。解决方案是邻票预渲染 + 跟手滑入：打开股票时把结果列表上一只/下一只预渲染到第二画布（previewPane，复用同一 buildOption），副图横滑时预览画布跟手位移，松手过阈值（44px）后新票数据先就位再走 200ms 收尾动画交换两个 slot。代价是内存多持有一份邻票 ECharts 实例（仅抽屉打开且有结果列表时占用）。通用启示：用户说「慢/卡」时不要默认是加载问题，先实测分层定位是取数、渲染还是动画。
