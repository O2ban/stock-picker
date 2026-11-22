---
id: memory-636
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T00:49:52+08:00
updated: 2026-11-19T00:49:52+08:00
importance: low
category: 方法经验
keywords: [静态前端, 无需重启, 调试清理, stock-picker]
summary: stock-picker 前端属静态文件改动，刷新即生效、不需要重启服务；验证完应关闭调试浏览器并清理临时目录，不留后台进程。
---
stock-picker 的服务端和前端在此类改动中没有动逻辑，只是静态文件，刷新页面即生效、不需要重启。改完后应顺手关掉调试用浏览器、清理临时目录、确认没有遗留后台进程，并向用户说明。
