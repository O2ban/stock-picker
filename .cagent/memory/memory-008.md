---
id: memory-008
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T19:05:08+08:00
updated: 2026-09-21T19:05:08+08:00
importance: medium
keywords: [minimal-implementation, single-path, fallback-removal, code-simplification]
summary: 减少功能复杂度时应移除所有降级兼容路径，保持单一路径实现以避免维护负担。
---
当项目需要收敛到最小化实现时，应删除所有降级兼容路径（如CLI兜底、演示数据分支、多模式适配层），保留单一可靠路径。本案例中移除了SQLite CLI兜底和演示数据分支，只保留better-sqlite3直连kline.db的单一路径，避免未来维护多套逻辑的负担。该原则适用于任何需要从复杂架构收缩的场景。
