---
id: memory-014
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T20:47:47+08:00
updated: 2026-10-15T20:32:35+08:00
importance: medium
category: 其他
keywords: [stock-picker, API_BASE, sub-path, location.pathname, manifest-404, dev-vs-prod-path, nginx]
summary: stock-picker 前端 API_BASE 通过 location.pathname.startsWith('/stock-picker') 自动识别子路径，index.html 里写死的 /stock-picker/manifest.webmanifest 绝对路径在正式子路径下是正确的，直连 3100 根路径看到的 manifest 404 只是开发调试现象不是缺陷。
---
stock-picker 前端为 nginx 子路径部署设计：`API_BASE = location.pathname.startsWith('/stock-picker') ? '/stock-picker' : ''`，自动识别前缀。

由此推论：index.html 里写死的绝对路径 `/stock-picker/manifest.webmanifest` 在正式访问路径（`oban9.com/stock-picker/`）下是正确的。

排查陷阱：用 3100 端口直连根路径做验证时，会看到 manifest 报 404——这是开发调试路径下的必然现象，不代表线上有缺陷。判断某个 404 是真缺陷还是环境差异前，先确认前端设计的目标访问路径。

（nginx 端口直连验证时若 curl 返回 000，可能是走了代理或被强制 TLS，加 --noproxy 再试；与本问题无关。）
