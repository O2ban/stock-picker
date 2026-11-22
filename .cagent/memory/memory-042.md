---
id: memory-042
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T22:56:25+08:00
updated: 2026-10-15T22:56:25+08:00
importance: medium
category: 其他
keywords: [stock-picker, app.js, local:current, strategy-save-misroute, local-draft-overwrite, short-path-inconsistency, save-target]
summary: stock-picker 中当 currentStrategyId 为 'local:current'（用户存过本地草稿）时，保存判断会拒绝把目标切回库里的真实策略，导致界面显示库里策略但保存却写进并覆盖本地草稿。
---
stock-picker 的 app.js 存在一处短路径不一致（约 451 行）：`if (currentStrategyId !== 'local:current') currentStrategyId = hit.value`。当用户在设置页存过一份本地草稿后，该判断会阻止保存目标改回库里的真实策略，结果是界面显示的是某条库策略的内容、点保存却把本地草稿覆盖成别名策略的内容，造成草稿被悄悄破坏。属冷门边角，但修复只需一行调整且改完设置页保存目标不再错位。可作为'存在本地草稿概念时、防覆盖守卫反而误伤'这类状态 bug 的参考案例。
