---
id: memory-452
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T09:27:23+08:00
updated: 2026-10-20T09:27:23+08:00
importance: medium
category: 错误教训
keywords: [公式, :=赋值, NODRAW, 多画线, Z, M, ZG, ZD]
summary: 通达信公式中 Z:=、M:= 用 := 是赋值不画线、ZG/ZD 标了 NODRAW，早期却把它们误当输出变量绘制，导致多出两根线，排查公式绘图数应先按 : 与 := 的语义数真实输出变量。
---
分时公式线最初多画了两根，根因是把通达信公式里用 := 赋值的变量（Z、M）和标了 NODRAW 的变量（ZG、ZD）误当输出变量绘制。通达信语义：冒号 : 是输出会画线，:= 只赋值不画线，NODRAW 标记的变量也不画。正确输出只有 中、PP、HH、M20 四条，实测 FORMULA_LINES 应为 4 项。接入任何用户提供的通达信公式时，要先按此行语义筛出真正的输出变量集合，再交给绘图。
