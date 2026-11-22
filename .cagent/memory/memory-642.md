---
id: memory-642
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: high
category: 错误教训
keywords: [mergePicks, 并发写, 临时文件名, 写锁, read-modify-write]
summary: 清单落盘 read-modify-write 无进程内互斥、临时文件名固定为 <date>.json.tmp，手动跑一次与自动盯盘交叠时后写者 rename 会覆盖前者新增的票，需加写锁且临时名带 PID/随机后缀。
---
H4 缺陷：intraday-picks.js 的 mergePicks 是「read → 改 → write」，临时文件固定为 <date>.json.tmp；手动 POST /api/intraday-picks/run 与自动盯盘没有共享互斥（running 只挡自动 tick 之间，server.js 直接调 runPickOnce）。两次运行交叠时后写者 rename 覆盖前者，前一次新增的票整批丢失。修法：进程内加一把写锁 + 临时文件名带 PID/随机后缀，并对 read-modify-write 全程持锁。已做 temp+rename 这点是对的。
