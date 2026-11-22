---
id: memory-011
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T19:17:26+08:00
updated: 2026-09-21T19:17:26+08:00
importance: medium
keywords: [stock-picker, 策略持久化, 内存存储, 数据丢失]
summary: stock-picker的策略保存和运行记录当前仅存在Node.js内存Map中，服务重启后全部丢失，尚未实现SQLite持久化。
---
stock-picker项目中策略保存接口虽然存在，但实际只是写入Node.js内存中的Map：重启后消失、无SQLite策略表、无版本历史、页面无策略列表复用入口。运行结果同样只存内存，无历史记录列表和审计能力。
