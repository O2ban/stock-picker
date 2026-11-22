---
id: memory-059
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T14:26:45+08:00
updated: 2026-10-19T14:26:45+08:00
importance: medium
category: 其他
keywords: [stock-picker, 审查处置, realtime:false, 量比回退分支, 真问题, 保留口径]
summary: 本轮审查核实后只剩两处真问题：realtime:false 时仍拉行情、engine 量比回退分支分母含当日；其余口径保留。
---
stock-picker 本轮审查核实结果：误报一条（MA 口径）、真问题两条——(1) realtime:false 时仍然发起行情拉取，违反「非交易时段不更新」的意图；(2) engine 的量比回退分支分母含当日，与库内 VR 排除当日的口径不一致，会在缺少预计算数据走到回退路径时产生口径漂移。处置原则：口径类问题在库内数据验证后再定性，只改有实据的，不因审查意见条数多而扩大改动面。
