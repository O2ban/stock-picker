---
id: memory-007
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T18:56:02+08:00
updated: 2026-09-21T21:37:41+08:00
importance: medium
keywords: [kline.db, better-sqlite3, 数据库直连, KLINE_DB, 依赖复用, node_modules]
summary: stock-picker 应复用 kline-trainer 已安装的 better-sqlite3 模块直接读取其 kline.db，不重新 npm install、不复制数据库、不下载行情，数据库路径由 KLINE_DB 环境变量配置。
---
stock-picker 与 kline-trainer 共享同一运行环境和数据库。better-sqlite3 原生模块直接复用 kline-trainer 目录下已安装好的版本，不在 stock-picker 自身目录重新 npm install（原生模块安装常超时且无必要重复）。数据库文件直接使用 kline-trainer 的 kline.db，通过 KLINE_DB 环境变量配置路径。不复制数据库、不下载行情数据。代码中引用 better-sqlite3 时需确保 Node.js 能从 kline-trainer 的 node_modules 中找到该模块（如通过 NODE_PATH 或相对路径引用）。
