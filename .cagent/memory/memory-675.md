---
id: memory-675
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T22:46:24+08:00
updated: 2026-11-19T22:46:24+08:00
importance: medium
category: 用户习惯与关切
keywords: [strategy-modification-discipline, no-unrequested-change, incremental-tuning, explain-before-change]
summary: 用户对分时策略有明确修改纪律：不许擅自改条件，每次只改点名的几条并事先说明，逐步精细化打磨而非一次大幅变动。
---
用户在 stock-picker 日内分时策略的迭代中反复强调：不要自行改动策略条件；每次只改他明确点名的那几条；改动内容要事先告知；策略要一条一条精细打磨，绝不能一次大幅调整。配合用户【memory-667】的『逐步加条件+每轮测试后讨论』偏好，构成了完整的工作节奏：提出假设→只改指定条件→跑数据→汇报对照结果→用户拍板下一步。违反此纪律（顺手优化其他条件或一次改多条）会直接破坏用户对归因的信任。
