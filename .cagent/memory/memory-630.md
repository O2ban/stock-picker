---
id: memory-630
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-18T23:50:24+08:00
updated: 2026-11-21T23:25:36+08:00
importance: medium
category: 用户习惯与关切
keywords: [复盘页入口, 入口移除, 按回测方案选股, stock-picker, 复盘页改造]
summary: 用户要求复盘页下拉直接选择「回测方案b」即可选出这只票，并删除复盘页原来的独立入口。
---
stock-picker 复盘/测试页的交互定位：下拉框里选的应是回测方案（如「回测方案b」），选完就能在列表里找到这只票；原复盘页那个独立入口（301557逐笔复盘按钮等）用户明确要求不要保留。做改版时应以下拉选方案为主要入口，避免重复入口并存。
