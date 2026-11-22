---
id: memory-443
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T00:34:15+08:00
updated: 2026-10-20T00:34:15+08:00
importance: low
category: 其他
keywords: [分钟K线, 分时公式, X/Y参数, PEAKBARS, TROUGHBARS, 公式兼容]
summary: 接入用户提供的分时公式时 PEAKBARS(1,X/10,1)/TROUGHBARS(2,X/10,1) 的 X、Y 参数未给值，需向用户确认实际数值而非自作近似。
---
用户在分时图上要求画「中/T/PP/M/HH/M20」等多条公式曲线，其中 PEAKBARS(1,X/10,1) 和 TROUGHBARS(2,X/10,1) 的 X、Y 参数没有赋值，当前用 zigzag 峰谷算法近似、阈值取常量。若用户实际使用固定数值（如 X=3、Y=5），应写死并保证与通达信换算一致；此类「公式迁移」任务的默认动作是先把缺失参数显式问清。
