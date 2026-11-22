---
id: memory-667
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T11:49:40+08:00
updated: 2026-11-19T11:49:40+08:00
importance: high
category: 用户习惯与关切
keywords: [策略打磨流程, 谨慎改条件, 逐步精细化, 先说后改, stock-picker]
summary: 用户对分时策略的修改有明确纪律：不许擅自改条件，每次只改点名的几条、改动要告知并逐步精细化打磨，绝不一次大幅变动。
---
在打磨分时买点策略时，用户明确要求：说改哪条就只改哪条，改动前必须告知，不允许未经通知擅自调参或改逻辑；每次只做小步精细化，不要一次变化太大。agent 应把要动的条件逐条列出、做成可开关可调阈值，并请用户逐条确认后再落地。这条纪律适用于 stock-picker 全部策略参数调整。
