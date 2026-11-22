---
id: memory-449
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T09:27:23+08:00
updated: 2026-10-20T09:27:23+08:00
importance: medium
category: 错误教训
keywords: [refreshTimeline, 竞态, tlToken, 旧请求覆盖, currentIdx, crossY]
summary: 分时校准存在三个状态一致性缺陷：刷新不取消在途请求导致旧日期结果覆盖新数据、currentIdx 被重置使锁定十字线跳回09:30、轴区间变化后 crossY 像素未重新锚定导致读数漂移。
---
分时图 refreshTimeline 的竞态与状态错位：1) api.load() 不会作废进行中的 refreshTimeline，旧日期的分时结果返回后会盖掉新数据并再次触发跨日重载，修复是引入请求令牌 ++tlToken 丢弃过期响应；2) 每 30 秒校准会重置 currentIdx=-1，十字线锁定时读数跳回 09:30，修复是锁定状态下回填 currentIdx；3) 越界重画改成只改 yAxis 后像素坐标没变但价格范围变了，crossY 需要按 anchorVal 重新锚定，否则十字线读数漂移。通用教训：异步刷新必须带令牌作废旧响应，凡是坐标→数值的换算，在数据区间变化后必须重新锚定而非复用旧像素。
