---
id: memory-573
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T13:50:41+08:00
updated: 2026-10-21T13:50:41+08:00
importance: medium
category: 代码逻辑
keywords: [缓存策略, network-first, 静态资源, 无需升版本号, stock-picker, 离线缓存]
summary: stock-picker 的离线缓存是 network-first 策略，静态资源改完立刻生效，不需要改缓存版本号；这与『必须升 sw 版本号才能刷新图标/资源』的 PWA 场景要分开判断。
---
stock-picker 前端使用的离线缓存是 network-first（有网优先），因此改完静态资源后自动就是最新的，不需要更新缓存版本号；判断『改完要不要提版本号』应先确认该站点的缓存策略是 network-first 还是 cache-first，不能一概按 PWA 惯例要求升版本。
（对照：PWA 图标等被系统层/SW 预缓存列表固定的资源仍需升 sw 版本号并让已装应用卸载重装。）
