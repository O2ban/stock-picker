---
title: 当日选股接入实时价 + 盘中量比口径 + 审查修复
category: 运行与发布
date: 2026-10-20
updated: 2026-10-20
status: active
tags: []
summary: 时间：2026-10-19 范围：stock-picker（src/server.js、src/engine.js、public/app.js） 1. 明确「先拉最新股价再选股」是…
---

# 当日选股接入实时价 + 盘中量比口径 + 审查修复

**时间**：2026-10-19
**范围**：stock-picker（src/server.js、src/engine.js、public/app.js）

## 任务目标
1. 明确「先拉最新股价再选股」是否更快。
2. 修 `REALTIME_PRICE_MAP` 从未赋值 → 当日选股实际没用实时价的空转缺陷。
3. 修盘中量比失真（上午量 / 全天均量 → 恒定偏低）。
4. 修选股完成后历史 chip 高亮不跟随新结果。
5. 修 `baseDate` 与实时价口径矛盾（结果 close 是今日价、基准日却报库内最后完成日）。

## 结论
先拉实时价**不会更快**，全市场 5373 只约多 3.3s（首轮 3281ms，5s 缓存内 3ms）。
但必须拉：不拉的话盘中选出来的是上一交易日收盘的答案，是正确性问题而非性能问题。

## 实现要点

### 实时价链路（src/server.js）
- `localDate(d)`：本地日期。不能用 `toISOString()`（UTC 08:00 前会算成前一天，早盘会把实时价插到错误日期）。
- `intradayFraction(now)`：交易时段 9:30-11:30 + 13:00-15:00 共 240 分钟，返回已走比例；收盘后 = 1（自动退化为原口径）。
- `realtimeDateFor(dataLatest, now)`：能否补今日 K。条件 gapDays 1~4、今天非周末、frac > 0。返回值同时用作「补不补」和「对外 baseDate」，两者共用同一判断避免矛盾。
- `applyRealtimeToDaily(dailyMap, enabled, dataLatest, quoteMap)`：改用传入的 `quoteMap`（Map<code, quote>），append 今日 bar 并重算 ma5/10/20/60 与 vr5/10/20/60，`vr = vol / (均量 × frac)`。
- `POST /api/screenings`：仅 `!body.baseDate && !strategy.baseDate` 时 `fetchQuotes` 拉全市场并建 quoteMap；失败只 `console.error` 并降级。

### 量比口径（src/engine.js）
`volume_ratio` 分支的展示分母 `volumeMa` 原为 `sma(rows,'vol',length)`（含当日），与 ratio 分母不一致。
改为 `effMa = current.vol / pre`，与 ratio 真实分母对齐。

## 子代理只读审查（2026-10-19）→ 3 条

- **[P1] 停牌股/节假日仍会凭空补出「今日假 K 线」**：`realtimeDateFor` 只看自然日，验不出快照是否属于今天。
  - 停牌股 `quotes.js` 用昨收顶替 price（>0 通过检查）、vol=0 → 退回 `last.vol`（昨天全天量）→ 假 bar。
  - 工作日节假日上游返回上一交易日快照 → 全市场都被补一根假日 bar，baseDate 报今天。
  - 早盘 frac 很小时假 bar 的量比被成倍放大。
  - **已修**：`applyRealtimeToDaily` 增 `if ((q && q.date) !== today) continue;` 与 `vol > 0` 硬门槛，并取消「退回上一交易日成交量」的兜底；`POST /api/screenings` 建 quoteMap 时先 `items.filter(it => it.date === todayStr)`。
- **[P2] 当前周拼合周线的量比未做盘中折算**：实时补的「部分量」被卷进 `curWeek.vol`，除以历史整周均量 → 周线量比系统性偏低，且与日线 frac 口径矛盾。
  - **已修**：实时 bar 打 `rt: true` 标记，拼当前周时 `allDailyRows.filter(r => !r.rt)`；`makeDailyMapper` 透传 `rt`；`aggregatePeriod` 在遇到 rt 行时先剔除（覆盖 weekly 缺失走日线聚合的回退分支）。
- **[P3] `activeHistoryId` 高亮可能被策略过滤条件吃掉**：`syncStrategyBar` 在策略名输入框为空时直接 return，`filterStrategyName` 停在上一个策略，新条目被 `visibleHistory()` 过滤掉。
  - **已修**：`saveHistory` 里同步 `filterStrategyName = item.strategyName || ''`。

审查确认无问题的方向：`realtimeDateFor` 的周末/跨月/UTC-CST 判定、MA/VR 切片边界（`slice(-n)` 与 `slice(0,-1).slice(-n)`）、buildLoader 与 POST 的 baseDate 一致性（共用同一 `realtimeDateFor`）、quoteMap 数据流无引用污染、fetchQuotes 全失败降级路径完整、engine 的 `pre > 0 ? vol/pre : null` 无除零。

## 实测结果

| 场景 | baseDate | elapsedMs | passed | count |
|---|---|---|---|---|
| 当日选股 limit5（首跑，含缓存冷启动） | 2026-10-19 | 15512 | 865 | 100 |
| 当日选股 ×3（缓存热） | 2026-10-19 | 2422 / 1648 / 1712 | 865 | 100 |
| 审查修复后复测 | 2026-10-19 | 2006 | 865 | 100 |
| 历史基准日 2026-09-30 | 2026-09-30 | 2880 | 548 | 3 |
| 周线策略（volume_ratio week） | 2026-10-19 | 2959 | 1704 | 3 |

- 实时价生效：结果 close 与 `/api/quotes` 完全一致（bj920006 20.62、bj920010 9.01、bj920021 7.93、bj920045 439.65、bj920060 26.7），mismatch 0。
- 历史基准日不混今日价：2026-09-30 取 bj920030 5.12 / bj920066 19.71 / bj920146 5.68，与今日实时价不同。
- 行情快照新鲜度：5373 只全部 date=2026-10-19，stale 0；vol=0 共 7 只（sh600293、sh601059、sh601198、sh603759、sz002388、sz301314 等），主要来自科创板/北交所。
- 量比展示一致性：bj920006 `volume 94351 volumeMa 16217.6 ratio 5.8178`，`volume/volumeMa = 5.8178` 与 ratio 相等。
- 前端 chip 高亮（/tmp/uitest/chips.mjs）：连续两次选股 `activeCount 1`，高亮落在最新条目；`meta` 文案 `100/3,052 · 1.62s · 基准日 2026-10-19 · qfq · 预计算`。
- `npm test` 5/5 通过。

## 运维备注
- 后端非 pm2 管理：`setsid pkill -f "^node src/server.js"` 停止（`pkill -f "node src/server.js"` 会误杀启动 shell），`setsid nohup node src/server.js >> stock-picker.log 2>&1 < /dev/null &` 启动。
- `public/` 静态文件按请求实时读盘，前端改动刷新即生效；`src/` 改动必须重启。
- 策略 `limit` 合法范围 1–500。

## 耗时归因定案（2026-10-19 14:0x）

「2006ms 恶化到 6.5s」是**口径变化造成的误读**，不是性能退化。2006ms 那次测的是当日选股 `limit=5` 的极简策略（单条件 `close_above_ma`），6.5s 是 `low-suck-v2`（15 条 expr + 深回看 71 天）。

交替 3 轮同进程实测（`/tmp/attrib.mjs`，均 `universe.excludeSt:true`、全市场 5373 只）：

| 策略 | elapsed | loadMs | evalMs | passed |
|---|---|---|---|---|
| starter（内置）首跑 | 7377 | 7040 | 337 | 627 |
| starter 热 | 1972 / 1942 | 1506 / 1491 | 466 / 451 | 623 / 624 |
| low-suck-v2 首跑 | 9164 | 5290 | 3874 | 21 |
| low-suck-v2 热 | 6176 / 6160 | 2543 / 2538 | 3633 / 3622 | 21 |

拆解 1.95s → 6.16s 的 +4.2s：
- **+1.05s 取数（loadMs 1.50→2.54）**：low-suck-v2 的 `low70=llv(ref(close,40),30)` 使 `calcNeedDays` 到 ~71 根 → `barsToCalendarDays` 约 115 天窗口，且需 OHLC（uses `low`）。
- **+3.15s 求值（evalMs 0.45→3.63）**：15 条 expr 全量求值，每条 `evalNode` 对每个 i 做 `slice`+reduce（O(n·window)），且 `exprResult` 每条件新建 Map 缓存、`screenChunk` 对全部条件求值无提前退出。

已验证的代价系数：
- 条件数与 eval 近似线性（`/tmp/perf_dup.mjs`：1/3/15 条廉价条件 → eval 123/302/1540ms）。
- 深窗口放大单条成本（`/tmp/perf_ohlc.mjs`：收窄 needDays 使 eval 4.0s→2.25s，但语义改变）。
- 前缀短路收益显著（`/tmp/perf_prefix.mjs`：前 6 条已把候选从 4445 压到 568，后 9 条只对 568 只求值，但因无短路仍全量算）。
- 本地基准（`/tmp/est_cache.mjs`，300 只）：共享 cache 1.22x、加短路 5.82x。

结论：现状 6.2s 与「策略复杂度」严格对应，非回归。若要提速，唯二有效方向是 **共享表达式缓存 + 条件短路（预期 eval 3.6s→0.6s）**，未获批准不动。

## 缓存污染修复（2026-10-19 14:1x）

**问题**：`public/chart.js` 的 `applyPayload` 原来写 `state.klines = payload.klines || []`，与 `fetchKlines` 写入 `writeCache` 的 `payload.klines` **是同一个数组对象**。随后 `mergeQuoteIntoSeries` 会 `state.klines[len-1] = bar` / `push(bar)` 原地改这个数组，等于把盘中实时价直接写进了 memCache 与 IndexedDB —— 缓存里留下一根「盘中残价」的当日 K 线，回源失败或离线重开就会画出一根假 K 线，且价格停在打开页面那一刻。

**修复**：`state.klines = (payload.klines || []).slice();`（浅拷贝足够 —— mergeQuoteIntoSeries 只替换数组元素为新建对象，从不原地改 bar 对象）。

**验证**（`/tmp/uitest/cacheproof.mjs`）：打开 sz000807 看盘 4.5s 后读 IndexedDB：`{key:"云铝股份", len:320, lastDate:"2026-10-16"}` —— 缓存里没有 2026-10-19 那根实时 bar，而主图确实画了 321 根、最后一根 `x=2026-10-19`、`[25.39,25.73,25.23,25.88]`、`vol 263979`，与 `/api/quotes` 一致。

## IndexedDB 排查收口（14:16）

之前 `cacheclean3.mjs` / `cacheclean4.mjs` 一直报
`NotFoundError: One of the specified object stores was not found`，`cacheclean4` 还返回
`META {"dbs":[],"version":1,"stores":[]}`。**根因不是缓存没写入，而是探针本身的 URL 写错了**：
`cacheclean4.mjs` 用的是 `http://127.0.0.1:3100/stock-picker/`，该子路径直连返回 404，页面根本没加载，
自然也不存在库和 store（`cacheclean3` 同源问题：脚本在页面还没写入缓存前就取 transaction）。

用 `http://127.0.0.1:3100/`（根路径，与浏览器实际访问一致）的 `cacheproof.mjs` 复跑：
`{"kline":[{"key":"云铝股份","len":320,"lastDate":"2026-10-16"}]}` —— store 存在，缓存里最后一根是
2026-10-16，**没有当日实时 bar**，`applyPayload` 浅拷贝的修复有效，缓存污染问题不存在，该项关闭。

## 实时价一致性复核（14:1x）

`/tmp/verify_final.mjs` 首轮报 2 只 MISMATCH（sh600060 结果 27.64 vs 行情 27.65）。用「选股前后各拉一次行情、看结果 close 是否落在两次快照的价格区间内」复核（`/tmp/rt_exact.mjs`），结果 close 落在区间内 → **是两次拉取之间价格跳了一分钱，不是口径 bug**。sz000807 未命中策略所以 close 为 null，属正常。

---

# 引擎提速：共享缓存 + 条件短路 + 尾部求值（2026-10-19）

## 一、提速三刀

1. **单票单周期内共享表达式缓存**：`screenChunk` 内按 period 各建一个 Map 传给 `exprResult` / `indicatorResult`，同一 code 内所有条件复用已算过的变量与指标（原先每条条件各建一份，`low-suck-v2` 13 个 vars 被重复算 15 遍）。
2. **条件短路**：按 `strategy.all` 原顺序求值，遇第一个 `!pass` 立即 `break`。通过项仍算满全部条件（明细不裁剪），只有出局票省成本，所以提速有天花板。
3. **尾部求值**：按周期裁剪尾部 bar，只保留最长窗口所需历史。

## 二、尾部求值实现要点

- `lookback(node, vars, seen)` 递归算表达式所需有效历史长度：`field`→1，`ref`→`n + inner`，窗口函数→`n + inner`，其余取 `max(子节点)`。
- 不再在 `exprResult` 内切片（`value.bars` 需要报全量长度、缓存也要同源 rows），改为在 `screenChunk` 里按周期统一算一次 `tailFor(period)`：
  `need = max(lookback(expr) + 1, length + 1, fast + 1, slow + 1)`，`rows = full.slice(-need)`。
- `indicatorResult` / `exprResult` 多接一个 `fullBars` 参数，仅用于把 `value.bars` 报成全量长度，语义与提速前完全一致。
- 周线同理，只是 `need` 以「周」为单位裁剪。

## 三、对拍结果

对拍方式：离线数据 `/tmp/ab/data.json` + 直调 `screenChunk`，不走 HTTP。判据是「passed 代码集合全等」+「逐条 value 明细全等」。

**第二刀（共享缓存 + 短路）相对提速前 `/tmp/engine.js.bak-perf`：**

| 策略 | 提速前 | 提速后 | 倍数 | 对拍 |
|---|---|---|---|---|
| base（low-suck-v2） | — | — | **2.55x** | codesEq ✅ detailEq ✅ |
| base-rev | — | — | **11.82x** | ✅ ✅ |
| base-wide（20 条） | — | — | **2.81x** | ✅ ✅ |
| base-week | — | — | **1.15x** | ✅ ✅ |

**第三刀（尾部求值）相对第二刀（`/tmp/ab/cur*.json` → `/tmp/ab/exp*.json`）：**

| 策略 | 第二刀 | 加尾部求值 | 倍数 | 对拍 |
|---|---|---|---|---|
| cur（low-suck-v2） | 3090ms | 1396ms | **2.21x** | codesEq ✅ detailEq ✅ |
| cur-rev | 769ms | 493ms | **1.56x** | ✅ ✅ |
| cur-wide | 3167ms | 1389ms | **2.28x** | ✅ ✅ |
| cur-week | 2249ms | 2142ms | **1.05x** | ✅ ✅ |

**边界压力对拍** `/tmp/ab/stress.mjs`：33 组策略全部 `ALL_STRESS_EQUAL`，覆盖各指标 length 2/3/20/60/250、`ma_cross_up` 各种 fast/slow 组合、深引用大窗口表达式、常量表达式、周线混合长窗口、20 条条件上限。

## 四、子代理只读审查

结论：无 P0/P1/P2 阻塞项。两条 P3（均判断为无害、未改）：
- vars 环引用时 `lookback` 会递归到 NaN，恰好与旧实现行为一致（属既有缺口，`validateExpr` 本就未做环检测）。
- 窗口 `need` 比理论下界多 1 根（`n + inner` vs `n + inner - 1`），只是少裁一根，不影响结果。

## 五、合入与线上实测

- 备份 `src/engine.js` → `/tmp/engine.js.bak-tail-<HHMM>`，`cp /tmp/ab/engine_exp.js src/engine.js`；`node --check` → `SYNTAX_OK`，`npm test` 5/5，`npm run check` → `CHECK_OK`；`src/engine.js` 20977 bytes。
- 服务重启后线上实测（`realtime:false`，`low-suck-v2`）：首跑 `engineMs 25732`（异常，见下），第二次 `engineMs 3842`；API 返回 codes 与离线 `base.json` 完全一致。

## 六、线上耗时拆分（补充测量，解释了上面两个疑点）

后来直接读 `/api/screenings` 响应里的 `loadMs` / `elapsedMs` 字段，连跑 3 次：

| run | wall | elapsedMs | loadMs | engine ≈ elapsed-load | passed |
|---|---|---|---|---|---|
| 0 | 3973 | 3934 | 2487 | **1447** | 23 |
| 1 | 3910 | 3899 | 2538 | **1361** | 23 |
| 2 | 3904 | 3892 | 2510 | **1382** | 23 |

两个疑点由此收口：

1. **「首跑 25.7s」不是引擎问题**：那是进程刚起、DB 文件不在 OS page cache 里的首次冷读，属一次性成本（watchdog 每小时重启类场景才会重现）。稳定态 `engineMs` 是 1.36–1.45s，和离线 1.4s **完全对上**，说明尾部求值在线上确实生效、没有 HTTP 层额外放大。
2. **现在真正的瓶颈换成了取数**：`loadMs 2.5s` 占 `elapsedMs` 的 **64%**，引擎只占 35%。再看 `universeSize 5373`，瓶颈是「全市场 5373 只 × 各自 needDays 窗口」的 SQLite 逐票读取，而不是表达式求值。

所以下一步若还要压响应时间，方向应该是**取数层**（批量 SQL / 覆盖索引 / 按需窄列），而不是继续优化 engine。

## 七、周线为什么只有 1.05x

`strategy-week.json` 只有 4 条条件且含周线，周线在库里是预聚合表，`need` 裁剪后原始行数本就不多（每票约 300 周 → 裁到几十周），省下的 `slice`/reduce 占比小；而分母里有大量无法裁剪的固定开销（取数、拼合、行映射）。收益低是结构性的，不是实现问题。**未做 eager 预取**：周线只占总耗时的小头，为它加预热逻辑属于用复杂度换不到可感知的收益，不做。

## 八、冷缓存 25.7s 已定性 + 取数层根因（2026-10-19 19:0x）

### 受控实验

`sync && echo 3 > /proc/sys/vm/drop_caches` 清空 OS page cache 后，对同一请求（`low-suck-v2` + `realtime:false`）连打 3 次：

| run | wall | elapsedMs | loadMs | engine ≈ | passed |
|---|---|---|---|---|---|
| 0（冷盘） | 26295 | 26207 | **24736** | 1471 | 23 |
| 1 | 3798 | 3787 | 2433 | 1354 | 23 |
| 2 | 3791 | 3775 | 2436 | 1339 | 23 |

**结论：冷缓存异常 100% 落在 load，engine 完全不受影响**（冷 1471ms vs 热 1339–1354ms，差异在噪声内）。
之前把 25.7s 记成 `engineMs` 是记账口径问题——`elapsedMs - loadMs` 才是 engine，早前误把整个 `elapsedMs` 当了 engine。

**根因**：kline.db 3.8GB，冷盘下每次按 `code IN (...) AND date BETWEEN` 走主键区间扫描，全是随机读，命中率≈0。

### 取数层现况拆解（热缓存，离线测）

| 环节 | 行数 | 热耗时 |
|---|---|---|
| `loadIndicators`（close,vol，纯 expr 策略只取 2 列） | 437364 | 473ms |
| `loadRecentDaily`（OHLC，strategyNeedsOhlc 为真时合并用） | 437364 | **963ms** |
| `groupByCode` | — | 78ms |
| `mapDaily + filter` | — | 93ms |
| `byCodeDate` 字符串键建表 | — | 371ms |
| 合并查表 | — | 58ms |
| 合计 | — | **≈2.0s**（线上 loadMs 2.43s，差额为 chunk 循环与实时/周线附加） |

两次查询都返回**同一批 437364 行**——同一段窗口的数据被完整读了两遍。

### 等价性核实（决定能否合并的关键证据）

`daily_indicators.close/vol` 与 `daily_kline.close_qfq/vol` 在同一 (code,date) 上是否等价：

- 2026-06-20 ~ 2026-10-16：437364 行，`closeDiff 0` / `volDiff 0`
- 2025-10-01 起：1364351 行，`closeDiff 0` / `volDiff 0`
- 2024-10-01 起：2669579 行，`closeDiff 0` / `volDiff 0`
- 全库行数 `indicators = kline = 9513347`，join 后仍 9513347（**无「仅 indicators 有的停牌填充行」**）
- `kline.vol=0 但 indicator.vol>0` 的行数：**0**

即：停牌填充是在入库阶段就写进 `daily_kline` 的，两表行集与数值完全一致，`close/vol` 可互换。

### 合并查询的收益（冷/热都测，交替两轮）

| 方案 | 冷盘 | 热盘 |
|---|---|---|
| 现状：indicators(close,vol) + kline(OHLC) 两次查 | 21245 / 21623ms | 968ms |
| 单查 kline(OHLC+vol)，close 取 close_qfq | **10888 / 11065ms** | **544ms** |

冷盘近乎翻倍（21.3s → 11.0s），热盘 1.78x。原理不是「省了 0.8s 的 JS」，而是**随机 I/O 次数直接砍半**——冷盘下这才是主导项。

### 已实施方案：两查合一（2026-10-19 19:2x 上线）

对「`strategyNeedsOhlc` 为真且 `strategyNeedsMaVr` 为假」的策略（即纯 expr + 需要 OHLC 的策略，`low-suck-v2` 正是此类）走单查：
在 `buildLoader` 里用 `loadRecentDaily(codes, {from,to,adjust:'qfq'})` 一次拿全列（`close_qfq AS close` + `vol` + `o/h/l/amount`），跳过 `loadIndicators`，并把后面的 OHLC 合并块条件从 `strategyNeedsOhlc(strategy)` 收紧为 `needsOhlc && !singlePass`。

- 改动面：`src/server.js` 的 `buildLoader` 共 3 处（新增 `singlePass` 判定、`dailyMap` 三元选择、OHLC 合并块条件），不动 `db.js`、不动 engine。
- 不适用场景保持原样：需要预计算 `ma*/vr*` 列的策略（必须查 indicators）、`adjust !== 'qfq'`（走 `loadDaily` 现查）。
- 附加收益：省掉 `byCodeDate` 那 371ms 的字符串键建表。
- 风险：依赖「两表等价」这一经验事实；若日后预计算脚本改了停牌填充口径或复权基准，该分支会静默偏差。已用停牌股/除权股专项覆盖，代码里也留了注释说明该假设。

#### 实施与验证记录

- 备份 `/tmp/server.js.bak-onepass-1923`（原 36787 bytes），改后 **37716 bytes**。
- `node --check src/server.js` → `SYNTAX_OK`；`npm test` 5/5；`npm run check` 通过。
- 服务重启：旧 pid 324521/324522 → 新 pid `334897`/`334898`，`/api/health` 返回 `{"ok":true}`。
- HTTP 层 before/after 对拍（`/tmp/ab/onepass/cap.py`，8 组 = 4 策略 × {实时补价, 历史基准 2026-06-30}）：**8/8 `codesEq=true detailEq=true`**。
  - `strategy-rev`：load 2692→1408（rt）/ 2463→1156（hist）
  - `strategy-wide`：load 2457→1186 / 2413→1165
  - `strategy-week`：load 5086→1478 / 2346→1393
  - `low-suck-v2`：load 2538→1168 / 2424→1170
  - passed 数量全部不变（23/9/367 等）
- 停牌股/除权股专项（`/tmp/ab/onepass/edge.mjs`，窗口 2026-06-01~2026-10-17）：停牌股 2059 行、除权股 180647 行，合计 182177 行，`missing=0 closeDiff=0 volDiff=0 nullOhlc=0 indicatorOnlyRows=0`。
- 空值复查：2026 年起 `daily_kline` 1039338 行，`close_qfq/open_qfq/vol` 全无 NULL；`daily_indicators` 同批 1039338 行同样无 NULL。
- 唯一已知的**无害差异**：`singlePass` 路径的行会带上真实 `amount`（`daily_kline` 有该列），旧路径经 `loadIndicators` 的行 `amount` 恒为 0。engine 的表达式字段白名单只有 `open/high/low/close/vol`，`amount` 仅用于周线桶累加、不参与任何条件判定，故对结果零影响；对拍 `detailEq=true` 也印证了这点。
- 冷缓存复测（`drop_caches` 后重放 `low-suck-v2` + `realtime:false`）：
  - run0 `wall=15792 elapsed=15695 load=14313 passed=23`（改前同条件 24736ms → **降 42%**）
  - run1 `wall=2668 elapsed=2654 load=1301 passed=23`（改前 2433ms → **降 47%**）
  - engine 侧未受影响（仍在 1.3~1.4s 量级）。

#### 子代理只读审查结论（task SbNltIx9）

- 结论：**可放行，无 P0/P1**。
- 报告里唯一的 P2（`volume_ratio` 回退分支量比分母含当日）经核对为**过期快照误报**：当前 `src/engine.js:226` 已是 `sma(rows.slice(0, -1), 'vol', length)`，且该修法早在 18:37 的 `/tmp/engine.js.bak-perf` 里就已存在，先于本轮改动。无需处理。
- 其余 4 条 P3 全部是**既有**、与本轮取数改动无因果关系，本轮不动（避免扩大改动面）：休市误判后不自动解除、server 侧时区依赖宿主机本地时间、除权除息日盘中 rt bar 涨跌幅失真、缓存命中后回源失败会回滚已画好的图。
- 审查确认的关键点（与本轮相关）：周线防前视过滤方向正确；补不补实时价与对外 `baseDate` 口径一致；历史基准日绝不混入今日价；停牌/节假日假 K 线三重跳过；缓存浅拷贝无反向污染路径。

## 2026-10-20 统一最新价来源 · 落地与验证

### 已落地改动
1. `src/quotes.js`：服务端行情缓存 `CACHE_TTL_MS` 5000→2000，让前端 3 秒节奏不被缓存吃掉。
2. `public/chart.js`：
   - `applyQuote` 分两条路径——分时只更新末点（`updateTimelineTail`），日线走 `mergeQuoteIntoSeries` 后 `renderQuote` + `updateKlineTail` 增量更新；
   - 去掉原先日线 8 秒整图重绘节流；
   - `updateKlineTail` 用 merge 方式只更新 series/xAxis/dataZoom，追加新 bar 时仅当用户停在尾部才推 `dataZoom.endValue`；
   - 主图纵轴 `scale:true`，让新高新低不被裁掉。
3. `public/app.js`：
   - `QUOTE_MS` 60000→3000，`SPARK_MS=25000` 缩略图独立节流、`force` 应对 DOM 重建后空白 canvas；
   - `refreshQuotes(only, opts)` 新增 `silent`：看盘 3 秒轮询只写 quoteMap 不重绘列表 DOM；
   - `scheduleQuotes`/`tickQuotes` 可见性驱动：页面隐藏停刷、回前台立即补拉；休市自证 + 单向自愈；
   - `scheduleChartQuote`/`chartQuoteTick` 看盘 3 秒轮询，每 10 轮（≈30s）对齐一次整条分时曲线；
   - `openChart` 先取价再画图，`openCode` 竞态丢弃过期回填；`closeChart` 关抽屉后立即补拉重绘列表。

### 关键约束（不可破）
- 实时价只叠加展示层，绝不写回 memCache/IndexedDB。
- `mergeQuoteIntoSeries` 仅 `period==='day' && adjust!=='hfq'`；周/月线聚合柱禁用。
- 分时曲线只画线，不作价格来源。
- 单只看盘样本只做单向自愈：可解除误判休市，不能判定休市。

### 踩坑
- 测试脚本伪造时间踩了两个坑：① `Date.UTC(2026,9,20,10,30,0)` 是 UTC 10:30，换算北京时间是 18:30，已在收盘后，导致轮询不启动、误以为功能没生效；正确写法应传 `Date.UTC(2026,9,20,2,30,0)` 才是北京时间 10:30。② 选择器要用 `#watch-list .stock-row`，`.watch-list` 不存在。

### 验证结论（verify31 / verify33）
- 列表盘中 3 秒节奏实测间隔 ~3005/3028/3004ms，三只票价格/涨跌幅/缩略图正常。
- 看盘日K 3 秒 tick 生效：末根 K 柱随注入价逐轮上移，报价与涨跌幅同步，纵轴自动扩张，涨幅超阈值后描金色边生效。
- 切后台 8 秒 tick 完全停止（delta=0），回前台 2 秒内补拉 2 次，符合预期。
- 关抽屉后列表价格与最新一致，无倒退。

### 遗留
- 周K「本周未走完这根」单独立项，本轮不动。
