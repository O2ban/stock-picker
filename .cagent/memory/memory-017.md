---
id: memory-017
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T22:47:29+08:00
updated: 2026-09-21T22:47:29+08:00
importance: medium
keywords: [stock-picker, failed-to-fetch, html-misparse, timeout, error-signature, frontend-debugging]
summary: stock-picker 前端出现 Failed to fetch 或响应体被误当作 HTML 解析，通常不是网络故障，而是后端计算耗时过长导致 Nginx 或上游超时后返回 HTML 错误页，需区分网络层故障与上游超时。
---
在 stock-picker 项目已确认：前端的 Failed to fetch 和 'Unexpected token <' / JSON 解析失败这类报错，在本项目语境下最常见的根因是选股扫描全市场耗时过长，浏览器请求先超时；若请求到达 Nginx 但上游超时，Nginx 会返回 HTML 错误页，前端把它当 JSON 解析就会报 Unexpected token '<'。排查时应先看后端扫描耗时是否触发了 Nginx 的 proxy_read_timeout 或浏览器默认超时，而不是先去怀疑网络层或反代配置。这与 memory-140（全局）描述的通用模式一致，此处补充 stock-picker 场景下的具体触发条件：全市场 5574 只同步串行扫描 + 事件循环阻塞 → 上游长时间无响应 → 超时链路触发。
