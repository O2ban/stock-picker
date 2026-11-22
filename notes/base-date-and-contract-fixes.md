---
title: 选股基准日（时间筛选）+ 前后端契约修复
category: 运行与发布
date: 2026-10-08
updated: 2026-10-08
status: active
tags: []
summary: 时间：2026-10-08 范围：stock-picker（前端 public/，后端 src/server.js、src/db.js） 用户要求：① 在 HTML 界面增加时间筛…
---

# 选股基准日（时间筛选）+ 前后端契约修复

**时间**：2026-10-08
**范围**：stock-picker（前端 public/，后端 src/server.js、src/db.js）

## 背景

用户要求：① 在 HTML 界面增加时间筛选；② 提供访问链接；③ 反馈"能显示但提示服务未连接"。
随后用户拍板"全修"。

## 访问入口

- 内网：http://127.0.0.1:3100/
- 外网：https://k.oban9.com/stock-picker/ （nginx 反代到本机 3100 的 /stock-picker/ 子路径）
- 启动：`setsid nohup node src/server.js > stock-picker.log 2>&1 &`
- 注意：不要用 `pkill -f`，会匹配到自身命令把 shell 杀掉（已踩坑）。用 `kill <pid>` 或 `pkill -f 'node src/server.js'` 需谨慎。

## 时间筛选语义

「选股基准日」= 站在某一天回看。默认最新交易日；快捷项：最新 / 一周前 / 一月前 / 三月前。
后端参数 `baseDate`（YYYY-MM-DD），优先级：options → strategy → 数据最新日。

## 修复的缺陷清单

### A. 前端契约错位（导致"服务未连接"）
1. `loadStatus` 读 `status.source.mode`，后端返回的是 `status.dataSource.mode` → 取 undefined 抛错被吞。
2. `/api/stats` 后端返回 `{stocks, kline, dailyIndicators, weeklyKline, weeklyIndicators}`；前端原先读的字段名不匹配。
3. `renderResults` 读 `run.resultCount`、`run.source`、`run.adjust`、`run.finishedAt`，后端 run 对象实际是 `count`、`source`、`adjust`、无 finishedAt（用 startedAt）。
4. 前端发请求体字段是 `dsl`，后端读的是 `strategy` → 自定义策略从未生效（一直回退 starter）。已对齐为 `strategy`。
5. 策略校验接口失败时返回 HTTP 200 + `{ok:false,error}`，前端只看 HTTP 状态码 → 永远显示"校验通过"。已改为读 `ok` 字段。
6. `#validation` 初始文案"策略加载中"永不更新，改为空。

### B. 时间线正确性（回看可信度的命门）
7. **前视偏差**：基准日落在周中时，库里那根完整周线（含基准日之后的收盘价与成交量）仍被算进 MA/VR 窗口。修法：只保留「整周结束日（周一+6天）≤ 基准日」的周线，其余剔除。
8. **当前周重复插入**：去重判断读的是 `week_start`，但 db 层已把列别名成 `date` → 判断永远为假，当前周被插两次。修法：读 `row.date ?? row.week_start`。
9. **curWeek 缺 c 字段**：合成周线只有 `close` 没有 `c`（引擎读 `.c`）→ 当前周被 MA 窗口排除。修法：同时写 `close` 和 `c`。
10. **实时补齐误用系统今天**：原先用系统日期判断，周末/假期会插出未来合成行。修法：以数据最新日为锚点，仅当今天与数据最新日相差 1~4 天且今天是工作日时才补。历史基准日（baseDate < dataLatest）绝不补实时价。
11. **后复权/未复权分支完全失效**（passed 恒为 0）：该分支直接返回 daily_kline 原始行（字段 `open/close`），而引擎读的是 `o/c`；且未按时间窗裁剪。修法：用 mapDailyRow 映射字段、按基准日窗口裁剪，周线传 null 由引擎自行聚合。

### C. 校验与边界
12. `validateBaseDate`：校验 YYYY-MM-DD 格式 + 真实日期（拦截 2/30）+ 不得晚于数据最新日。
13. 前端快捷按钮：去掉与「最新」语义重复的「清除」；高亮判断改为按当前值匹配。
14. 日期输入框设置 min（最新日 - 400 天）/ max（最新日）。

## 实测结果（2026-10-08）

| 场景 | passed | top1 |
|---|---|---|
| baseDate 2026-09-18（最新） | 566 | sz002453 |
| baseDate 2026-09-16（周三，周中） | 372 | sh688004 |
| baseDate 2026-09-14（周一） | 426 | sz002790 |
| baseDate 2026-08-18 | 510 | sh603079 |

- 周中基准日结果与整周结束日明显不同 → 前视过滤生效。
- 修前默认基准日 passed=590，修后 566 → 少了重复插入的当前周与未来完整周线的影响。
- adjust 三口径实测（8-18）：qfq 510 / hfq 517 / raw 477，全部出数（修前 hfq、raw 恒为 0）。

## 验证命令

```bash
# 策略可控性：自定义 momentum 策略能改变结果
curl -s -X POST http://127.0.0.1:3100/api/screenings -H 'Content-Type: application/json' \
  -d '{"strategy":{"version":1,"all":[{"period":"day","indicator":"momentum","params":{"length":5,"min":0.03}}],"limit":3}}'

# 基准日校验
curl -s -X POST http://127.0.0.1:3100/api/screenings -H 'Content-Type: application/json' -d '{"baseDate":"2027-01-01"}'
```

## 子代理代码审查结论（2026-10-08）

P0 阻断 0 项；P1 严重 3 项；P2 一般 6 项；P3 建议 6 项。任务点 (a)-(h) 逐条核实：8 条实现本身均无误。

### P1（严重，静默偏差）
- **P1-1 hfq/raw 分支未做周线防前视过滤**：把 weekly 传给引擎让其自行聚合，但聚合出的末周是「基准日所在的部分周」（只含周一至基准日），被当成完整周线参与 MA/VR 窗口；qfq 路径有过滤而这条没有 → 两条口径结果不可比，周量比系统性偏低（≈真值 × 已入库天数/5）。**这是本次修复引入的残留，必修。**
  修法：对聚合结果套用同一过滤器 `filter(r => shiftDate(r.date, -6) <= baseDate)`。
- **P1-2 实时补齐守卫在长假后失效**：`gapDays` 限制 1~4 天，A股长假（国庆/春节 ≥5 天）后不补，但当前周拼合照常执行 → 拼出缺节后首日的残缺周，且对用户无任何提示。
- **P1-3 当前周 vol 是残缺周，混入 VR 分母**：当前周 vol 为本周已入库交易日之和，而 VR 分母是完整周均量 → 周量比系统性偏高（与 P1-1 方向相反）。基准日恰在周五（数据覆盖整周）时才是对的。属既有设计，改动会影响量比语义，需用户决策。

### P2（一般）
- P2-1 `REALTIME_PRICE_MAP` 从未配置，实时补价整条链路（约 15 行）是死代码；前端却暗示是"最新"数据。
- P2-2 预计算滞后时 `baseDateInput.max` 卡在旧日期，用户无法选今天且界面不说明原因。
- P2-3 前端默认策略写 `sort.direction`，后端 starter 写 `sort.order`，字段名不一致（当前不校验不报错，潜伏 bug）。
- P2-4 `#strategy-name` 输入框内容从未被采集发送，纯装饰。
- P2-5 板块下拉的「演示数据」在后端无匹配数据，选它返回 0 结果且无提示。
- P2-6 `/api/stats` 返回 5 个字段前端只用 2 个，无法从界面判断预计算表是否完整。

### P3（建议）
- `weekStartOf`、`WARMUP_DAYS`、`loadRecentDaily`、`hasPrecomputedIndicator` 为死代码。
- 周线行缺 o/h/l，将来开放月线或新增依赖高低的指标会静默算错。
- 回归测试缺失。

## 遗留待查（不在本次范围）

- momentum 策略报"5周期涨幅 85.44%"，A股 5 日涨幅此量级异常，疑似复权数据或单位问题，需单独排查。
- `listStocks` 的 `excludeST` 参数实际未在 SQL 中生效（当前库无 ST 股，暂未暴露）。
- `name` 字段大面积为空字符串（北交所股票尤为明显）。
- 无 baseDate 回归测试用例（test-engine.mjs 仅 14 行）。
