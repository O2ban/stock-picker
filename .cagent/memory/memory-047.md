---
id: memory-047
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T12:41:50+08:00
updated: 2026-10-19T12:41:50+08:00
importance: medium
category: 其他
keywords: [stock-picker, 排序, 涨幅排序, orderedList, 自动重排, 迷你K线重绘, 邻票同步, cycleSort, quotes-items]
summary: stock-picker 列表加涨幅排序时，所有会重建列表的入口（排序切换、分钟行情自动重排）都必须把迷你 K 线重绘和邻票同步放进渲染函数，否则会出现 K 线空白和横滑落到旧顺序。
---
stock-picker 给自选/选股结果两个列表加按涨幅排序（点击循环：降序→升序→取消，仅改显示顺序不写回本地存储；横滑邻票使用同一套排序结果；无行情的票排最后）。

实现要点：
1. 排序并非唯一的重建入口——行情轮询触发的自动重排、cycleSort 切换排序都会重建列表。重绘迷你 K 线的逻辑若只挂在「加载 K 线」上，排序开着时每次行情导致顺序变化列表里的迷你 K 线就会集体变白。正确做法是把重绘放进 renderWatch / renderScreen 两个渲染函数里，覆盖所有重建入口。
2. 自动重排后必须调用 syncNeighbors 更新前后邻票，否则横滑会滑到旧顺序的股票。
3. 排序状态目前不持久化，刷新页面回到原顺序（如需记住可加 localStorage）。
4. 验证技巧：伪造 /api/quotes 返回使顺序反转，检查列表顺序反转 + 迷你 K 线全部重绘 + 打开中间一只再触发重排后横滑落点与列表顺序一致。注意该接口返回字段是 items（不是 quotes），Mock 写错字段会导致「排序未生效」的假象。

改动记录在 notes/sort-and-live-quote.md。
