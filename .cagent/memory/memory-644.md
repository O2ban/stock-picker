---
id: memory-644
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 约束限制
keywords: [自动盯盘, AUTO_DEFAULT, cfgOverride未赋值, 配置入口缺失]
summary: 自动盯盘的 from/to/everyMin（AUTO_DEFAULT = 0935/1000/5）没有任何配置入口，cfgOverride 定义了却从未被赋值，改时间窗只能改代码重启，是策略参数中唯一的硬编码例外。
---
M2：intraday-picks.js 的 cfgOverride 定义了却从未被赋值，strategies/*.json 也没有对应字段，AUTO_DEFAULT 只能改代码重启。策略参数其余项（window/gap/gain/vol/shape/entry/mid/prevDay/excludeLimitUp）已全部从 JSON 读取，无硬编码。另：前端文案也重复写死「早盘 9:35~10:00 每 5 分钟」，与服务端不同步，应直接用 auto.from/to/everyMin。
