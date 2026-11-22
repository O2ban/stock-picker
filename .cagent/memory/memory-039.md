---
id: memory-039
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T20:32:35+08:00
updated: 2026-10-15T20:32:35+08:00
importance: medium
category: 其他
keywords: [stock-picker, run:current, placeholder-item, strategy-bar, change-listener, 无效请求]
summary: stock-picker 策略栏的 'run:current' 是占位项（库里找不到历史记录策略名时用），选中它会让 change 监听器去请求 /api/strategies/run:current 必然 404，需加显式返回分支拦截。
---
stock-picker 策略栏中 'run:current' 是占位项——当历史记录里的策略名在当前库里找不到时用它兜底。问题：选中占位项会触发 change 监听器去 fetch `/api/strategies/run:current`，该 id 不存在必然 404，进 catch 分支静默忽略，产生无用请求和报错噪音。

最小修法：在 change 监听器里加一个显式返回分支，选中占位项直接 return，不发请求。验证时不仅要确认无 404，还要确认守卫真的拦住了网络请求（而不是靠 404 兜底）。

背景：策略栏选中项若与设置页编辑器不一致（策略栏写着 A、设置页是 B），是同一处状态同步问题，需一起修。
