---
id: memory-002
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T10:45:15+08:00
updated: 2026-09-21T10:45:15+08:00
importance: high
keywords: [AI选股, 策略DSL, 脚本审计, 选股模式]
summary: 选股应用采用AI将自然语言转换为受限策略DSL再执行的方案，保证脚本可审计、可复用、安全可控。
---
选股模式：AI根据用户自然语言需求生成选股策略，但AI只负责把需求转换为受限的受限策略DSL，不直接执行任意脚本。策略和对应脚本可保存复用，保证可审计性和可复现性。前端通过AI生成筛选条件并调用服务端接口，而非前端自行计算。
