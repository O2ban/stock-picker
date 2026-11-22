---
id: memory-874
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T13:34:08+08:00
updated: 2026-11-22T13:34:08+08:00
importance: low
category: 代码逻辑
keywords: [分时浮层, 左右箭头, 日期导航, 循环切换, stock-picker]
summary: 分时浮层左右箭头在days所有键排序列表中前后切换（navSubmin+renderSubminDate），到头禁用支持循环，非301557票禁用。
---
分时浮层日期导航实现：index.html加prev/next按钮（#rvd-submin-prev/next），rv-data.js的navSubmin(direction)在subminDates数组中前后移动subminDateIdx，renderSubminDate(dstr,rect)重新渲染该日期的分时图；updateNavBtns根据是否在首尾位置设置disabled状态；非301557票（无分钟数据）时禁用箭头；showRemoteSubmin需重置subminDates/subminDateIdx避免残留状态。
