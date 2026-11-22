---
id: memory-578
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T21:22:11+08:00
updated: 2026-10-21T22:43:42+08:00
importance: medium
category: 方法经验
keywords: [缓存版本号, sw-version, network-first, 旧代码, stock-picker]
summary: stock-picker 离线缓存是 network-first，普通静态资源改完即生效无需升版本号；但负责管理离线留存的 sw 版本号未升级会让浏览器认为仍是老版本、不更新代码，导致断网重开看不到任何内容。
---
本轮出现「手机上一只显示旧界面」的两种成因要分开判断：普通静态资源走 network-first 缓存，改完刷新即取最新，不必升版本号（强行升反而清空旧缓存）；但承载离线留存数据写入逻辑的 Service Worker 若版本号不升，浏览器判定老版本不用更新，旧 sw 也不会保存留存数据，于是断网重开永远空白。此时需升 sw 版本号，并把线上三个文件逐个与本地比对确认一致、确认手机缓存已切到新版本。
