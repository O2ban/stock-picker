---
id: memory-821
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-20T09:12:19+08:00
updated: 2026-11-20T09:12:19+08:00
importance: medium
category: 用户习惯与关切
keywords: [stock-picker, 排序口径, 清单历史页, 实时涨幅, 出手涨幅, 自选页, 选股页]
summary: stock-picker 三处列表的涨幅排序口径已定：自选页与选股页按当前实时涨幅、清单当天页按实时涨幅、清单历史日期按出手时记录涨幅，实现在 public/app.js 公共排序取值处。
---
stock-picker 全站涨幅排序的统一口径：自选页和选股页按当前实时涨幅排序；清单当天页按实时涨幅；清单历史日期坚持用出手时记录的涨幅（因为该页行内展示的就是出手涨幅）。修复落在 public/app.js 的公共排序取值处，仅改这一处即可覆盖三页。验证方式：前端脚本语法检查 + 项目测试（5 项）。注意未做登录后的页面交互端到端验证。
