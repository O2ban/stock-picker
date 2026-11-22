---
id: memory-639
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: high
category: 错误教训
keywords: [行情请求, URL长度, 分批请求, withdrawSnapPrimed, 离线留存, 清单页]
summary: 清单页把整份股票清单拼进一次行情请求的 query，超过约1600只时URL超长导致请求失败，还会连带撤销本地留存行情使页面永远显示「--」，必须按可视窗口分批（≤100只）请求。
---
股票清单页曾有 H1 缺陷：refreshQuotes(pickRows.map(r => r.code)) 把整份清单（日内可达3000+只）拼进 query，而 allCodes() 里的 slice(0,100) 只在传 only 时被绕过、服务端也只取前100只。超过约1600只时 URL 超 16KB，Node 直接回错，request() 抛出带 httpStatus 的错误，走 withdrawSnapPrimed() 把本地留存行情一起撤掉，表现为清单页行情永远「--」。修法：清单页按可视窗口分批（≤100只/批）请求。验证时实测每批只发38/40/32只，远低于上游100只上限。
