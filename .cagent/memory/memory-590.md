---
id: memory-590
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:23:26+08:00
updated: 2026-10-23T20:23:26+08:00
importance: high
category: 错误教训
keywords: [strategyId, 静默回退, starter, 策略错配, rememberRun, 404]
summary: 请求里传了 strategyId 但系统找不到时静默回退 starter 会让用户看到完全是另一个策略的结果且无从察觉，必须显式报错。
---
server.js 三层回退 `body.strategy || strategies.get(body.strategyId) || strategies.get('starter')` 在 strategyId 拼错/未持久化/跨实例时为 undefined，静默落到 starter；同时 rememberRun 用 body.strategyId 记标签，导致历史记录显示『A 策略』实际跑的是 starter。同类问题：body.strategy 与 body.strategyId 同时传且不一致时用了 body.strategy 却记两个不一致的 id。修法：strategyId 查不到直接返回 404，rememberRun 存实际生效的 resolved strategy id。教训：凡『按 id 取配置 + 有默认值』的模式，id 显式传入却未命中时必须报错而非回退，否则产生用户完全不可见的结果错配。
