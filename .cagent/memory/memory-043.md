---
id: memory-043
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T23:29:57+08:00
updated: 2026-11-21T23:25:36+08:00
importance: medium
category: 用户习惯与关切
keywords: [表格左右滑动, 移动端表格, 数据显示不全, UI偏好, stock-picker]
summary: 用户要求移动端表格支持左右滑动以完整展示所有列，不能因列多导致数据显示不全。
---
用户明确指出现有分笔明细表格不支持左右滑动、数据展示不全，这是不可接受的。为 stock-picker 等移动端表格类组件设计列布局时，默认应做成可横向滚动的容器，而不是压缩列宽或截断列，优先保证所有字段可见。
