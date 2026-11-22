---
id: memory-594
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:23:26+08:00
updated: 2026-10-23T20:23:26+08:00
importance: medium
category: 用户习惯与关切
keywords: [审查报告核实, 部分属实, 审查自撤, 逐条源码核对]
summary: 子代理审查报告需逐条回源码核实——本次 P0 属实，但『loadShortDaily 不支持 toDate 参数』和『停牌 OHLC 不一致』两条是审查方自己看漏/撤回的。
---
审查报告称 loadShortDaily 的 toDate 参数被硬编码忽略，实际该参数一直存在只是调用时没传；审查还称停牌股 OHLC 两边不一致，后自行确认为两边都 null。处置模式与既有 memory-652/652 一致：审查条目逐条回源码核实，只改真问题，对误报如实说明，不因审查报告语气笃定就照改。
