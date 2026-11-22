---
id: memory-464
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T14:50:41+08:00
updated: 2026-10-20T14:50:41+08:00
importance: low
category: 方法经验
keywords: [静态前端, 刷新即生效, 无需重启, stock-picker]
summary: stock-picker 的 public/ 静态前端文件每次请求实时读盘，改动后手机上刷新页面即生效，不需要重启服务器；若看着没变化应先彻底关闭页面再重开以绕过缓存。
---
stock-picker 前端页面文件不走构建、每次请求实时读盘，因此修完前端后服务器无需重启，用户在手机浏览器刷新一次即可看到新效果；若之前打开过并且看起来没变化，应先彻底关闭页面再重新打开（必要时清站点数据或用 ?nosw=1）来绕过 PWA/Service Worker 缓存，避免把缓存问题误判为代码未生效。
