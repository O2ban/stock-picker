---
id: memory-876
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T15:35:33+08:00
updated: 2026-11-22T15:35:33+08:00
importance: medium
category: 方法经验
keywords: [分时图, 浮层, 十字线, 双向联动, suppress, 防死循环, stock-picker]
summary: 分时浮层与日K十字线双向联动的防死循环设计：正向（分时切日期→日K跳）与反向（日K十字线移动→分时切日期）通过suppress标志阻断回调循环，日K侧需暴露onCrossDate注册方法，浮层切日期时设suppress再调showCrossAtDate。
---
分时浮层与日K图的双向联动需要防绕圈保护：正向联动是分时浮层切日期时调用日K的showCrossAtDate锁定十字线；反向联动是日K十字线移动时通过onCrossDate回调通知浮层切日期。关键设计：①日K图表需暴露onCrossDate(fn)注册方法到api，否则外部无法注册回调；②showCrossAtDate内部设suppressCrossDate标志，在renderCrosshair执行期间阻断onCrossDate回调，防止浮层→日K→又回调浮层的死循环；③用crossDateKey去重键判断是否真的变了才触发回调；④hideCrosshair时清空crossDateKey并复位suppress标志。
