---
id: memory-022
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-01T19:02:35+08:00
updated: 2026-10-01T19:02:35+08:00
importance: medium
category: 其他
keywords: [stock-picker, precompute-config, indicator-tiers, scan-window, ma60-buffer, 4-tiers]
summary: stock-picker 预计算落地的具体配置决策：均线/量比只存 5/10/20/60 四档够用不再扩，扫描窗口按用户设定 3 个月并额外加 60 天缓冲区用于 MA60 计算（窗口外不入库只用于计算参考），此组合已定不再讨论。
---
档位决策背景：用户最初担心以后要用 MA30/MA50 会缺档，被明确告知扩到 120 档会让已 3.6G 的数据库再涨一大截，权衡后选择限定四档、够用就行。窗口决策：用户默认扫描近 3 个月数据，但算 MA60 需要往前多要 60 天数据，因此实际取数范围是'3 个月窗口 + 60 天缓冲 = 约 150 天'，多取的部分不出现在最终结果里但用于正确计算均线，这个缓冲是必需的不能省。若未来真要扩档再单独讨论扩档成本。
