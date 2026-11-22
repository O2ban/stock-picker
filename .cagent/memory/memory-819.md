---
id: memory-819
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-20T08:21:37+08:00
updated: 2026-11-20T08:21:37+08:00
importance: medium
category: 代码逻辑
keywords: [自动盯盘, 日内引擎, 单一路径, 重启生效, stock-picker]
summary: 自动盯盘与手动选股共用同一个日内引擎，改引擎规则会自动覆盖盯盘，但运行中服务是旧进程必须重启才生效。
---
stock-picker 的自动盯盘不是独立选股器，每分钟调用的就是同一个日内选股引擎，因此规则改动只需改引擎一处即可同时覆盖手动选股与自动盯盘，无需维护第二份判定。但要注意：改源码不等于线上生效，运行中的服务进程仍是旧代码，必须重启服务后新规则才会进入每分钟盯盘；重启后应再确认服务健康与运行进程。
