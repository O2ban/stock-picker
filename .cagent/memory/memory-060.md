---
id: memory-060
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T14:26:45+08:00
updated: 2026-10-19T14:26:45+08:00
importance: medium
category: 其他
keywords: [cacheclean, IndexedDB污染, 验证脚本地址写错, 404, 127.0.0.1:3100子路径, cacheproof, 浅拷贝修复]
summary: 「IndexedDB 污染」遗留问题的根因是验证脚本访问了会 404 的 /stock-picker/ 子路径导致页面从未加载，改用根路径 127.0.0.1:3100 后证明缓存正常、污染问题可关闭。
---
stock-picker 曾遗留「IndexedDB 污染」问题，最终查明根因不在代码而在验证脚本本身：cacheclean3/4.mjs 用的是 http://127.0.0.1:3100/stock-picker/ 这个子路径，而该路径直接访问会 404（项目早已记录），页面根本没加载，所以拿到 {"dbs":[],"version":1,"stores":[]} 是必然结果，不代表缓存没写入。改用浏览器实际访问的根路径 http://127.0.0.1:3100/ 后重跑 cacheproof.mjs，读到 320 根 K 线、最后日期停在 2026-10-16，没有 10-19 的实时 bar——恰好证明 applyPayload 的浅拷贝修复生效，污染问题关闭。
可复用经验：用脚本验证浏览器端缓存/存储时，必须使用与真实浏览器完全一致的访问 URL（含/不含子路径），否则所有「取不到数据」的结论都不可信；得到空结果时先怀疑页面是否真的加载成功。
