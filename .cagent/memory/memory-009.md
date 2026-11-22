---
id: memory-009
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T19:05:08+08:00
updated: 2026-09-21T19:05:08+08:00
importance: low
keywords: [better-sqlite3, native-module, installation, debugging, dependency]
summary: better-sqlite3等原生模块缺少index.js时是依赖安装不完整问题，非代码逻辑错误，需重新npm install修复。
---
当better-sqlite3等原生Node模块的node_modules目录中缺少index.js等入口文件时，通常是因为native module编译失败或安装中断导致的依赖不完整问题，而非代码逻辑错误。排查时应首先检查npm install是否完整执行，而不是添加更多兼容代码。本案例中在成功简化代码后仍遇到此问题，根因是环境依赖状态而非代码修改引入的问题。
