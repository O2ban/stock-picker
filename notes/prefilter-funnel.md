---
title: 选股预筛漏斗（两段式）
category: 运行与发布
date: 2026-10-23
updated: 2026-10-23
status: active
tags: []
summary: - 用户反馈：点选股偶发「fetch 失败」，再点一秒多就成功。 - 已修（2026-10-23）：选股请求单独 60s 超时（其他仍 8s）；去掉 POST 结果后再 GET 的…
---

# 选股预筛漏斗（两段式）

## 起因
- 用户反馈：点选股偶发「fetch 失败」，再点一秒多就成功。
- 已修（2026-10-23）：选股请求单独 60s 超时（其他仍 8s）；去掉 POST 结果后再 GET 的冗余往返；sw 版本 sp-v10 → sp-v11。
- 实测：low-suck-v2 全市场冷态 15.4s（loadMs 13.1s），热态 2.8~3.1s（loadMs 1.3s）。根因是 5000+ 只 × 75 天的行散布整库，磁盘随机读；内存 3.7G 装不下 4GB 库，页缓存频繁被挤掉。

## 方案（第一招，已获批实施）
两段式：先用最近 K 个交易日（K=8，可配 PREFILTER_MAX_DEPTH）的短窗数据跑「回溯深度浅」的日线条件淘汰，幸存票再走完整窗口跑全部条件。

### 必须守住的不变量
1. 预筛只能淘汰「确定不通过」的票；数据不足（NaN / 行数不够）一律放行。
2. 最终名单由完整流程重算，必须与改动前逐只一致。
3. 策略没有浅条件（shallow 为空）或 PREFILTER=0 → 自动退回原路径。
4. **预筛的最后一根 bar 必须与完整扫描口径一致：今天选股时要用盘中实时行情补出当日 bar（复用 applyRealtimeToDaily，量按开盘时间折算、打 rt 标记）。否则「今日收阳/今日涨幅」会拿昨日收盘判断，把今天才合格的票误杀。这是最容易出错的一点。**
5. 预筛只用 period==='day' 的条件；周线条件需要拼合周线，不进预筛。

### 改动点
- src/engine.js：新增 conditionDepth / planPrefilter，抽出 passesConditions 复用求值。
- src/db.js：新增 recentTradeDates。
- src/server.js：POST /api/screenings 插入预筛阶段，响应加 prefilter 统计；baseDate 需提前算（原在扫描后）。
- public/app.js：meta 行展示「预筛 5574→318」。
- public/sw.js：sp-v11 → sp-v12（若子代理已提到 v11 则再提一档）。

## 环境备注
- 服务：`nohup npm start` 起，PPID=1 孤儿进程，pid 见 stock-picker.pid；cron 每小时第 5 分跑 service-watchdog.sh 探活重启。
- 重启方式：kill 旧 pid → `cd /home/ubuntu/stock-picker && nohup npm start >> stock-picker.log 2>&1 &`
- 磁盘剩 8.1G，内存 3.7G（空闲约 1.8G）。
- 冷态测法：`sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`

## 暂不做（用户决定）
- 建 250 日热库、定时增量、空闲预热：第一招效果好就不做。若将来做，窗口要留一年，不能按当下策略剪。

## 待办
- [ ] 子代理实施完成后逐只比对名单（low-suck-v2 + 默认策略，开/关各一次）
- [ ] 冷热耗时对比表
- [ ] 改动 >5 处，需 code-review 子代理审查
