---
id: memory-058
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T14:26:45+08:00
updated: 2026-10-19T14:26:45+08:00
importance: high
category: 其他
keywords: [stock-picker, MA口径, VR口径, 实时bar, 含当日, 排除当日, 库内数据验证, 审查误报]
summary: stock-picker 预计算指标口径实测确认：MA 是含当日的（实时 bar 的 MA 必须含自身才与库内一致），VR 分母是不含当日的；审查提出的「MA 把实时 bar 算进去」是误报。
---
在核对审查意见时用库内数据验证了 stock-picker 两个指标口径，结论要长期记住：
- MA：库内 ma5 是含当日的口径。以 sh600060 为例，含当日算得 ma5_incl=27.058，与库内 ma5 完全一致；排除当日得 27.184，对不上。因此实时 bar 参与 MA 计算时必须包含自身，才与历史行同一口径。审查提出的「MA 窗口把实时 bar 自己算进去」属误报。
- VR（量比）：库内 vr5 是排除当日的口径（vr5=0.8945 对应排除当日分母；含当日则为 0.9795）。该口径保留不动。
教训：指标口径不能凭直觉统一处理，必须拿库内真实数据做正反两算比对；子代理审查意见也要逐条用数据核实，不能整体采信或整体否定。
