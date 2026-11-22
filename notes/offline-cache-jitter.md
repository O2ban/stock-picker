---
title: 指标区抖动修复 + 断网离线缓存（2026-10-21 晚）
category: 运行与发布
date: 2026-10-21
updated: 2026-10-21
status: active
tags: []
summary: - public/chart.js：新增 TLQUOTEFIELDS（分时 6 项：今开/最高/最低/昨收/成交量/成交额）、KQUOTEFIELDS（K线 7 项：最高/最低/开…
---

# 指标区抖动修复 + 断网离线缓存（2026-10-21 晚）

## 一、指标区抖动
- `public/chart.js`：新增 `TL_QUOTE_FIELDS`（分时 6 项：今开/最高/最低/昨收/成交量/成交额）、`K_QUOTE_FIELDS`（K线 7 项：最高/最低/开盘/量比/振幅/成交量/成交额）。
- `renderTimelineQuote` / `renderQuote`：数据为空时不再清空容器，改按固定字段渲染占位（数值 `-`），保证行情条高度在换股瞬间不变。
- `fillQuoteGrid`：离屏测宽时把数值统一替换为典型宽数值（`8888.88`），使占位态与有数据态的分行行数一致。

## 二、离线缓存
- IndexedDB `sp-kline-cache` v1 → v2，新增 `snap` 库存行情快照与分时曲线（`kline` 库保留不动）。
- `fetchKlines` / `fetchTimelineData`：成功即写本地；仅「网络彻底失败」才回读本地并标记 `cached:true` + `staleTs`。HTTP 5xx/404 不回落。
- `public/app.js`：`saveQuoteSnap` / `applyQuoteSnap` + localStorage（`sp:quotes-snap:v1`、`sp:spark-snap:v1`）存列表行情与迷你K线。
- 提示：`#offline-tip`（列表）、`#chart-offline`（图表），文本带留存时间，如「离线模式：显示的是 2026-10-21 21:07 留存的行情，不是实时价」。

## 三、本轮补的两处缺口
1. **断网冷启动不读快照**：启动序列前加 `if (navigator.onLine === false) handleOffline()`，离线重载不再显示 `--` / 「服务未连接」。
2. **联网后图内离线提示残留**：`chart.js` 增加 `markOnline()` 清 `srcCached`/`srcTlCached` 并收起提示；`app.js` online 回调里调用。

## 四、验证（CDP 无头浏览器，430×900 移动端模拟）
- `v_jitter.mjs`：慢换股 / 慢切分时 / 正常换股，240~300 帧高频采样，行情条高度恒为 78.4、两行、下方图表 656.6，无任何波动。
- `v_off3.mjs`：列表 在线 / 断网 / 断网重载 / 恢复 四态，断网与断网重载均 3 行数据 + 带时间提示；恢复后状态栏回「数据服务在线」、提示消失。
- `v_off5.mjs`：看盘 在线日K → 换股 → 分时 → 断网冷启动 → 离线日K → 离线分时 → 恢复联网，全部通过；图内提示「离线数据 2026-10-21」正确显示与消失。
- `v_http500b.mjs`：服务端 K线接口返回 500 重载后，状态显示「服务未连接」、未回退旧数据、未误报离线 —— 错误隔离约束成立。
- `node --check` 两文件语法通过；`npm test` 5 项全绿。

## 五、遗留
- `sw.js` 保持 `sp-v7` 未改：静态资源为 network-first，联网即取新版，无需递增；递增只会清空旧缓存、让离线首屏多一次拉取。若要保险可递增，待用户定。
- localStorage 快照在自选股接近 100 只时的容量与写入性能未压测。
- 换股/切周期/切复权各路径的离线标记传播已覆盖，但横滑连续换股 + 断网组合未单独压测。

## 六、备份
`/tmp/{app.js,chart.js,index.html,styles.css,chart.css,sw.js}.bak-2031`、`/tmp/app.js.bak-off`

## 2026-10-21 23:05 按只读审查补两处边界缺口

审查（task Sx8_2E6u）报出两处 P1，均属实，已修：

1. 主图回退分支丢留存时间戳（chart.js api.load catch）。原写 `applyPayload({...stale, cached:true})`，`applyPayload` 里 `cacheTs = payload.staleTs || 0` 变 0，离线提示缺“留存于几点”；冷启动+缓存过期+断网正是这条路。改为从持久层取 `rec.ts` 一并带上，与 `fetchKlines` 写法统一。
2. 迷你K线在服务端报错时被静默回填（app.js loadKlines）。原 `catch {}` 无差别吞掉 500，随后仍从 localStorage 快照回填小图，且 `sparkPrimed` 不清理 → 服务挂了小图还装作正常。改为 catch 里区分 `err.httpStatus`：服务端故障标记 `serverFault`、逐批撤掉该批 sparkPrimed 的小图、跳过快照回填；仅断网才走留存回填。同时 `withdrawSnapPrimed` 一并清理 sparkPrimed → klineMap。

验证：`v_spark500b.mjs` 像素统计，正常态三张小图墨迹 [2263,2125,2021]，接口 500 后 [0,0,0]（小图确实空了）、价格列 "--"、状态“服务未连接”；`v_off5`/`v_http500c`/`v_cold`/`v_jitter` 全过；`npm test` 5/5。

sw.js VERSION 升 sp-v9（此前 sp-v8 已在线上跑过一版，本次内容又变了，必须再升一级否则手机端沿用旧缓存）。

## 2026-10-21 22:35 收口复核

- 三个文件语法通过；线上 https://k.oban9.com/stock-picker/ 的 sw.js / app.js / chart.js 与本地逐字节一致，SW 缓存桶已是 sp-v8。
- 回归全过：
  - 屏蔽全部接口请求（模拟"连着 WiFi 没外网"）：在线 3 行有数 → 断网重载仍 3 行、3 个迷你K线、提示"显示的是 2026-10-21 22:32 留存的行情，不是实时价" → 恢复联网提示隐藏、状态回"数据服务在线"。
  - 接口返回 500：列表价格变"--"、状态"服务未连接"，没有拿旧价遮住故障。
  - 换股 + 慢响应：指标区高度恒为 78.4px，无"先缺行后撑开"。
  - 从未加载过的票离线时提示"本地还没有存过行情，联网后再看"。
- 已核：renderQuote 主图区也消费了 staleTs，提示带行情日期+留存时间；恢复联网时 app.js 会先 markOnline 清标记再强制回源重载当前票，不再有"旧K线当实时价"窗口。
- SW activate 会删除除当前版本外的所有缓存桶，旧 sp-v7 桶会被清掉，不占空间。
