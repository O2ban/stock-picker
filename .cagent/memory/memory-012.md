---
id: memory-012
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T19:17:26+08:00
updated: 2026-09-21T19:17:26+08:00
importance: medium
keywords: [stock-picker, README不一致, 文档同步, 项目状态]
summary: stock-picker项目的README存在与实际代码不同步的问题：仍描述演示数据兜底但代码已改为单一路径直连kline.db。
---
stock-picker的README仍写着'数据库不可用时使用演示数据兜底'，但src/db.js已改为直接连接真实kline.db的单一路径（符合memory-008的简化原则）。同时README声称策略和运行记录已保存，实际仅存内存。文档需随代码进度同步更新。
