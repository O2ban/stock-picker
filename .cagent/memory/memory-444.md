---
id: memory-444
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T08:32:55+08:00
updated: 2026-10-20T08:32:55+08:00
importance: high
category: 关键概念
keywords: [通达信语法, :=不画线, :输出, NODRAW, 多出两根线, Z, M]
summary: 通达信中冒号:是输出会画线、:=只赋值不画线，公式多出两根线的根因是把Z、M当输出而非NODRAW标记，排查公式绘图数应先按此行语义数真实输出变量。
---
通达信公式语法里 `:` 表示输出、会画线，`:=` 表示只赋值、不画线，`NODRAW` 是额外的不画标记。stock-picker 分时主图『多出两根线』的真因不在绘制层：Z:=... 和 M:=... 用 := 本来不画，但若被错误当成输出变量就会画出绿虚线和洋红虚线；真实会画线的只有 中:、PP:、HH:、M20: 四条。排查公式曲线数量时应先按 := / : 语义数出真实输出变量，再看 NODRAW 标记，不要一上来怀疑绘制层。
