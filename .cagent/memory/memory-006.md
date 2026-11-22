---
id: memory-006
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T18:43:55+08:00
updated: 2026-09-21T18:43:55+08:00
importance: low
keywords: [better-sqlite3, 原生依赖, 安装超时, npm install]
summary: stock-picker 中 better-sqlite3 原生模块安装可能超时，需在构建说明中记录处理方案。
---
npm install 在安装 better-sqlite3 原生模块时可能超过120秒超时，prebuild-install 有弃用提示。处理策略：先完成依赖安装再跑端到端检查，代码本身的纯引擎测试可独立运行不阻塞验证。
