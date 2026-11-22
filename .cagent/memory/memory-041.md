---
id: memory-041
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T22:38:34+08:00
updated: 2026-10-15T22:38:34+08:00
importance: medium
category: 其他
keywords: [stock-picker, strategy-rename, PUT-strategy-api, id-is-filename, no-new-option, backend-update, validateStrategy]
summary: stock-picker 策略『改名不新增』应走后端按 id 更新接口：策略 id 即 strategies/*.json 文件名，需写回对应文件并同步内存，前端保存改走后端后不再在本地下拉框新增策略项。
---
后端策略来自内置代码 + strategies/*.json（仅启动时读一次，POST /api/strategies 原先只往内存塞新 id 不写盘）。改名需求需新增按 id 更新的接口（PUT /api/strategies/:id）：id 即文件名，写回对应 json 并同步内存，下拉项保持原数量不新增。实现须保证 PUT 只做只读校验、不重建策略对象，否则 name 字段会丢导致改名无效。验证套路：用不存在的 id 应返回 404（旧代码会落到兜底分支返回 unsupported，可借此判断进程是否为旧版本）；端到端改名后核对『写盘 + 内存同步 + 下拉项数量不变』，测完还原并保持原文件文本风格（写回会重排成缩进格式）。
