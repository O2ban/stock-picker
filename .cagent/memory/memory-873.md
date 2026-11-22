---
id: memory-873
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T13:34:08+08:00
updated: 2026-11-22T13:34:08+08:00
importance: medium
category: 方法经验
keywords: [分时图标注, 买卖点标记, 智能位置, 防遮挡, ECharts, stock-picker]
summary: 分时图标注文字防遮挡采用smartPos(i,y,yMin,yMax)智能标签位置：顶部→bottom、底部→top、右边缘→left、左边缘→right，配合textBorderWidth:3和grid.top:26留白。
---
分时图买卖点标注防遮挡的实现要点：1）新增smartPos(i,y,yMin,yMax)函数根据标记在图表中的位置智能选择标签方向（顶部用bottom、底部用top、右边缘用left、左边缘用right）；2）textBorderWidth提到3增强文字可读性；3）grid.top从14改为26给顶部标签留白；4）买入日也画卖出提示：买点15:00标签带「次日et卖价格」（如15:00买89.04·次日09:31卖90.00）；5）被过滤笔画灰色虚线「本应买…（被过滤）」对照标注。
