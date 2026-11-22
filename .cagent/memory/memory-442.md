---
id: memory-442
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T00:34:15+08:00
updated: 2026-10-20T00:34:15+08:00
importance: low
category: 方法经验
keywords: [分时实时刷新, 纵轴裁剪, min/max重算, 节流重绘]
summary: 分时图纵轴 min/max 若在建图时算死，盘中创新高会超出范围被裁掉曲线，需实时比对极值越界即整条重绘并加节流。
---
分时图 3 秒 tick 只更 series 数据时，纵轴 min/max 是建图时算死的，盘中价格突破范围会把曲线裁掉。修法是实时比对当前极值与已绘范围，越界立刻整条重绘，并用 2 秒节流避免频繁重建。这是所有「增量更新数据但坐标轴静态」图表都要考虑的边界。
