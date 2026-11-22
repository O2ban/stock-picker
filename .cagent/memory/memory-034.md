---
id: memory-034
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T07:48:12+08:00
updated: 2026-10-15T23:58:09+08:00
importance: medium
category: 其他
keywords: [eltdx, eltdx_downloader.py, 通达信协议, kline-daily.timer, systemd-timer, 收盘后落库, 增量更新, 数据源]
summary: kline 生态的日线数据源是 eltdx_downloader.py(通达信协议)，由 systemd timer kline-daily.timer 每交易日收盘后(约15:45/15:48)触发增量下载，耗时约12分钟，因此盘中数据库内最后一根日K始终是上一交易日。
---
数据源链路：eltdx_downloader.py(位于 kline-trainer/kline-server)走通达信协议下载日线；调度由 systemd timer `kline-daily.timer` 在每交易日收盘后(约15:45/15:48)触发一次增量更新，单次耗时约12分钟。
关键含义：因是收盘后才跑，盘中数据库内日线的最新一根始终是上一交易日；当日K只能靠实时行情链路(如 /api/quotes + 前端合成)补齐。
注意：用户口头说的『tlrdx/tltdx』都是打错字，实际指的就是每天下午定时拉取日线的 eltdx 源。相关服务端 node 代码改动需重启，public 静态文件实时读盘无需重启。
