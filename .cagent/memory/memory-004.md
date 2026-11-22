---
id: memory-004
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T18:43:55+08:00
updated: 2026-09-21T18:43:55+08:00
importance: medium
keywords: [stock-picker, 架构设计, AI解耦, 适配层, 项目边界]
summary: stock-picker 项目采用AI解析作为可替换适配层的设计，避免核心选股链路绑死在某个模型服务上，核心执行链通过DSL实现。
---
stock-picker 是独立GitHub项目，位于 /home/ubuntu/stock-picker，与旧 kline-trainer 业务代码完全隔离。核心架构设计：AI自然语言解析作为可替换适配层接入，核心选股链路通过受限策略DSL执行，避免将执行链绑死在某个AI模型服务上。
