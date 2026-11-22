---
id: memory-651
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: low
category: 错误教训
keywords: [买点label, 贴边阈值, 45/190, 按像素实测]
summary: 买点 label 的贴边阈值按槽位写死 45/190，不随字号、文案长度、画布宽度变化，文案一长或窄屏再窄就会贴边被裁，应改为按像素实测 label 宽度再选方向。
---
L1：chart.js 买点 label 贴边阈值写死 45/190。当前 242 槽 + 4 字形态文案下实测不溢出，但脆弱。建议按实测宽度选方向。同轮验证确认买点箭头在极值时刻不会溢出（触发价必在降中线之上，落在价格面板上半区，12px 下移量足够）。
