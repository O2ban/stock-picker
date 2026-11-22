---
id: memory-013
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T19:17:26+08:00
updated: 2026-09-21T19:17:26+08:00
importance: low
keywords: [stock-picker, 月线预留, period支持, 功能边界]
summary: stock-picker项目中月线仅代码预留，实际遇到会报错，当前真实支持的周期只有日线和周线。
---
代码中保留了month period参数但实际执行时会报错（month period is reserved for a later release），当前真实支持的周期范围是日线+周线，不是完整的日线、周线、月线三周期。
