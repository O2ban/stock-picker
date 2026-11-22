---
id: memory-817
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-20T00:01:52+08:00
updated: 2026-11-20T00:01:52+08:00
importance: low
category: 方法经验
keywords: [自动盯盘, 下次时间显示, 不给假承诺, stock-picker]
summary: 自动盯盘状态显示只在当天窗口内展示「下次 HH:MM」，收盘后与周末不显示，避免给出假的执行承诺。
---
页面顶部原只显示「自动盯盘已开启」，看不出下一次何时触发。改为显示「下次 09:47」这类具体时间，但只推当天窗口内的时间——收盘后和周末干脆不显示。原则：给用户看的状态指示器不应包含无法兑现的承诺。
