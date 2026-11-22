---
id: memory-455
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T09:27:23+08:00
updated: 2026-10-20T09:27:23+08:00
importance: low
category: 错误教训
keywords: [越界重绘, 节流, 轻量setOption, 已消解, 旧审查报告]
summary: 基于旧版本（96222 bytes）的审查报告会列出一批已消解的问题（越界2秒节流裁切、niceStep guard、normalize单轴锁定），核对修复清单前必须先按当前代码逐条复核是否仍成立。
---
本轮两份子代理审查报告都是针对 96222 bytes 的旧版 chart.js，而当前已到 97511。逐条核对后发现：越界 2 秒节流窗口内曲线被裁切（改轻量 setOption 后不再需要节流）、niceStep 循环 guard（纵轴重写后不再走档位提升）、normalize 单轴锁定三条已消解；仍存在的多数是本轮新引入的行为回归而非历史遗留。方法教训：代码在持续修改时，旧审查报告只能作为线索清单，必须逐条对照当前代码复核，不能直接照着清单修。
