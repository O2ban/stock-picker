---
id: memory-879
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T15:35:33+08:00
updated: 2026-11-22T15:35:33+08:00
importance: low
category: 错误教训
keywords: [颜色常量, 搜索索引, C_HI, C_LO, grep搜索, stock-picker]
summary: 代码搜索索引可能漏命中已存在的常量（如C_HI/C_LO），搜不到不等于不存在，应直接定位文件确认而非误判为常量未定义。
---
在使用颜色常量C_HI/C_LO时，搜索工具没命中就误判为常量不存在，实际上这两个常量在461/462行正在使用。搜索索引可能存在漏命中问题（后续搜showCrossAtIdx也遇到同样情况）。教训：搜索搜不到时应直接定位定义处或看现有用法确认，而非基于搜索结果下结论说常量不存在。
