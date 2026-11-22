---
title: 看盘分时图 + 3 秒价格刷新
category: 记忆与时间线
date: 2026-10-20
updated: 2026-10-20
status: active
tags: []
summary: 1. 看盘界面新增「分时」周期，显示当日分时曲线（价格线 + 均价线 + 量柱）。 2. 当前打开的票，价格每 3 秒刷新一次。 3. 自选股 / 新查的票打开分时时同样加载曲线并…
---

# 看盘分时图 + 3 秒价格刷新

## 需求（2026-10-19）
1. 看盘界面新增「分时」周期，显示当日分时曲线（价格线 + 均价线 + 量柱）。
2. 当前打开的票，价格每 3 秒刷新一次。
3. 自选股 / 新查的票打开分时时同样加载曲线并 3 秒刷新。

## 关键实测结论

### 分时接口域名
- `web.ifzq.gtimg.cn/appstock/app/minute/query?code=xxx`
  → **有 WAF**。100 次连发 100 次 501，被拦。
- `proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code=xxx`
  → 100 次连发 100 成功，P50 12ms / P95 13ms。**用这个。**

### 返回结构
```json
{ "code":0, "data": { "sz000807": {
    "data": { "data": ["0930 25.39 1586 4026854.00", ...], "date": "20261019" },
    "qt": { "sz000807": [88 个字段...] }
} } }
```
- 每点：`HHMM 价格 累计量(手) 累计额(元)`
- 共 267 点；有效交易时段 242 点（09:30-11:30 121 个 + 13:00-15:00 121 个），
  15:00 之后 25 个是盘后固定价格交易，绘图必须过滤。
- 均价 = 累计额 / (累计量 × 100)。实测 4026854 / (1586×100) = 25.39 ✓
- 量柱 = 本分钟累计量 − 上一分钟累计量。

### 行情接口（已有）
`qt.gtimg.cn/q=...` 正常，3 秒一次毫无压力（P50 11ms）。
服务端已有 5s 缓存 + in-flight 去重。

## 设计

### 分层取数
```
实时价格（3s）      → qt.gtimg.cn     （现有 /api/quotes，独立 3s 定时器）
分时曲线（30s 校准） → proxy.finance.qq.com （新增 /api/timeline）
日线/周线           → kline.db        （现有，不动）
```
3 秒只拉 quote（约 500 字节），把最新价推到分时曲线最后一点；
每 30 秒拉一次 timeline 校准，补上新增的分钟点。避免 3 秒一次 10KB 的分时全量。

### 轮询分离（重要）
现有 `QUOTE_MS = 60000` 是全局列表轮询。不改它。
新增独立的看盘定时器：仅当抽屉打开（openCode 存在）且盘中时，3 秒一次。

### 分时渲染
在 chart.js 增加 `period = 'min'` 分支，独立 `buildTimelineOption`：
- panel0：价格线 + 均价线（weight 6）
- panel1：每分钟量柱（weight 2）
- x 轴固定 242 个槽位，曲线形状不抖动；不启用 dataZoom 交互。

## 改动清单
1. `src/quotes.js` — 新增 `fetchTimeline()` 解析 + 2s 缓存 + in-flight 去重
2. `src/server.js` — 新增 `GET /api/timeline`
3. `public/chart.js` — 分时周期渲染、applyQuote 分时分支
4. `public/index.html` — 周期栏加「分时」按钮
5. `public/app.js` — 看盘 3s 独立轮询

## 约束
- 不动现有日线/周线逻辑与复权口径
- 分时数据不进 klineMap / IndexedDB 缓存
- 非交易时段不轮询

## 进展
- [x] 后端 fetchTimeline（2s 正缓存 + 8s 失败负缓存 + in-flight 去重，缓存上限 120）
- [x] 后端路由 GET /api/timeline（无 code→400，上游异常→502）
- [x] 前端分时渲染（242 固定槽位 / price+avg+vol / 纵轴以昨收对称 / 轴内刻度只留 3 点）
- [x] 前端 3s 轮询（盘中 3s 拉 quote，每 10 tick≈30s 校准 timeline，休市降 30 分钟探测）
- [x] code-review（子 Agent 报 6 P1 / 3 P2 / 2 P3，逐条核实后修确认属实的）
- [x] 重启 + 验证

## 实测数据（2026-10-19 收尾）
- 时序：盘中伪造 10:30，15 秒窗口内 quotes 7 次（间隔 3.0s 稳定）、timeline 1 次
- MIN 视图：series = PRICE/AVG/VOL，各 242 非空点，x 首 09:30 末 15:00，dz {sv:0, ev:241}
- 纵轴：min 24.4972 / max 25.9228，中点 25.21 = prevClose，scale:false、splitNumber:4，昨收虚线可见
- 布局：canvas 390×653，grid 上 16/h447.75、下 491.75/h149.25
- 周期往返：day(320 根/10 series/复权 block) → min(复权 none/十字线不启用) → 重开仍 min → day → week(200 根) 全通
- 横滑换股（分时）：sh600519 → sz000807 成功，242 点、legend 正常
- 接口：`/api/timeline?code=sz000807` 242 点、date 20261019、prevClose 25.21；无效代码 502 且第二次 1.1ms 命中负缓存；无参 400

## 关键踩坑
- 腾讯分时原域名 `web.ifzq.gtimg.cn` 被 WAF 拦（100/100 返 501），必须用 `proxy.finance.qq.com`
- `tl.date` 是 `20261019`、`q.date` 是 `2026-10-19`，直接比较永不相等 → 必须 normDate 归一
- 15:00 后的盘后固定价交易点必须过滤，否则多出一个 1501 点破坏槽位对齐
- 某只票的形态不能自证"今天是不是交易日"（停牌股会误判）→ 已删除该判定，marketClosed 只由大盘/时间判断
- `pkill -f 'node .*src/server.js'` 会连带杀掉执行该命令的 shell 自身，重启务必用精确 pid

---

# 第二轮：纵轴满占 / 十字线 / 量比副图 / 公式曲线（2026-10-20）

## 需求
1. 分时纵轴太扁，按通达信坐标方式修正
2. 分时加十字线：点击唤出，上下滑动移动横线
3. 非交易时段彻底停掉 3 秒轮询与列表轮询
4. 量能副图下加量比曲线副图
5. 按用户通达信公式加 中/Z/PP/M/HH/M20 曲线

## 已完成改动
### src/server.js
- `/api/timeline` 增加异步返回 `vol5`（5 日均量，不含当日），供前端算量比。
  量比 = 累计量 /（5 日均量 × 已开盘时间占比），否则开盘第一分钟会冲出顶天尖刺。

### public/chart.js
- `TIMELINE_PANELS` 变三档：price weight 6 / vol weight 2 / ratio weight 2。
- `niceStep` 档位扩到 1/1.5/2/2.5/3/4/5/6/8 × 10^k（原 1/2/2.5/5 太疏，
  全天振幅 1%~2% 时步长会在「撑大区间」和「刻度挤成一片」之间跳）。
- 纵轴改造（本次核心）：区间主体取今日真实价格范围（含均价线），
  **昨收只在距离不超过区间 12% 时才纳入**，跳空太远就让它出画面；
  上下各 3% 余量；步长循环保证格数落 4~9 格；`min/max/interval` 三者同源。
  实测填充率 0.533 → 0.8，yAxis 25.3~25.9、interval 0.1。
- 量比副图：RATIO 序列 + yAxis[2]（min 0，max 由回调按数据算并按 0.5 取整），
  markLine yAxis:1（量比 1.0 心理线）。
- `timelineFormulas(price)`：中/ Z / PP / M / HH / M20 六条曲线。
  分时只有成交价（H=L=C），峰谷判定直接对价格序列做 zigzag。
- `renderCrosshairMin(index)`：分时专用十字线，横线位置由 `state.crossY` 决定（像素），
  读数带价格 + 相对昨收百分比，标签贴右；时间标签贴最下面板底边。
- 放开分时十字线：`toggleCrosshair` 分时下把点击像素写进 `state.crossY`；
  手势层新增 `moveCrosshairByPy`，纵向拖动直接改 `state.crossY`。

### public/app.js
- 删除 `probeOnly` 残留逻辑。
- 非交易时段（`!inTradingWindow()` 或 `marketClosed`）彻底不轮询，
  改为设一个「等开盘」定时器（`msUntilMarketOpen`，上限 6 小时）。

## 关键 bug（本轮修掉的）
**`moveCrosshairByPy` 坐标系错位**：入参是 `e.clientY`（视口坐标），
而 `gridRects` / `state.crossY` 都是画布内坐标。没减 `getBoundingClientRect().top`
表现为「手指动 60px、横线跳 194px 并撞到面板底」。修法：进函数先减 `box.top`。

**纵轴刻度与区间不同源**：旧代码 `interval: (yMax - yMin) / 8`，
但 yMin/yMax 是按 niceStep 对齐的，两者不整除 → 标出 25.2125 这种价。
修法：`niceStep` 的结果直接当 `yInterval` 传给 yAxis。

## 公式取值待定
用户公式中 `X`、`Y` 两个参数未定义，代码里用常量 `TL_PEAK_X` / `TL_PEAK_Y`（千分比 3 档）。
`FROMOPEN`、`PEAKBARS`、`TROUGHBARS` 到 242 槽位的换算是自行实现：
- `FROMOPEN` → 当前 bar 序号 k（从开盘算起）
- `PEAKBARS(1,X/10,1)` → 距上一个峰的 bar 数，zigzag 阈值 X/10%
- `TROUGHBARS(2,X/10,1)` → 距上一个谷的 bar 数

## 实测（2026-10-20，伪时间 10-19 10:30 CST）
- yAxis 25.3/25.9 interval 0.1，填充率 0.8，昨收 25.21 在画面外（高开 0.18 元，超过区间 12%）
- series 10 条：PRICE,AVG,中,Z,PP,M,HH,M20,VOL,RATIO，各 242 非空（VOL 223）
- 量比 n=242，首 0.87（09:30），末 0.70（15:00），峰值 3.41（09:35，开盘量集中）
- 点击画布 → 十字线出现（横线 y=164，竖线 13:12），纵拖 60px → 横线移动 60px（精确跟手）
- 夜里 21:00 打开：12 秒内 /api/quotes 零请求（initial 2 次是开图一次性拉取）
- grid: price 16/341.4、vol 385.4/113.8、ratio 527.2/113.8
- npm test 5/5、node --check 四文件通过、verify20/21/22 回归通过
- 截图：/tmp/uitest/shots/70-min-new.png、71-min-cross.png

## 已知遗留
- 3 秒增量更新只 setOption series，纵轴 min/max 是构建时固定的：
  **盘中新价突破 yMin/yMax 时曲线会被裁掉**，要等每 10 tick（30 秒）整条重绘才恢复。
  待评估：在 updateTimelineTail 里检测越界并触发整条重绘。
- 通达信纵轴档位的权威算法未找到原文，当前按「满占 + 整齐档位」自行推导。
- 无自动化单测覆盖 parseTimeline / timelineSeries / timelineFormulas / renderCrosshairMin。

# 第三轮（2026-10-20）：纵轴中轴对称重写 + 公式曲线纠错 + 十字线双向

## 纵轴：改用 HQChart DefaultSplit 口径
子 Agent 核实 `webhqchart/umychart.js` 的 `FrameSplitMinutePriceY`：
- `DefaultSplit()`（约 61340 行）：`distanceValue = max(|YClose-max|, |YClose-min|)`，
  然后 `max = YClose+distanceValue`、`min = YClose-distanceValue`。严格对称、无余量、曲线贴边。
- 最小跨度 `[1, 0.1, 0.01, 0.001, 0.0001]`，A 股 2 位小数 → 0.01 元；空数据/等于昨收兜底 ±10%。

代码改为：
```
d = max(|hi-base|, |base-lo|)   // hi/lo 含均价线
floorD = max(base*0.005, 0.01)   // 一字板兜底
yMin = base - d, yMax = base + d, interval = 2d/4
```
**删掉了「niceStep 向上取整到整齐档位」**——那正是「图太扁」的根：取整会把区间凭空撑大 20~50%。

## 公式曲线：只画 4 条
用户公式里 `Z:=...`、`M:=...` 用 `:=` 是赋值不画线，之前被误当输出变量画了出来（用户看到的
「多出两根线」）。真实输出只有 `中:`、`PP:`、`HH:`、`M20:` 四条。已删 Z/M 的生成与引用；
`ZG`/`ZD` 标 `NODRAW`，本来就不画。
`verify27.mjs` 实测 `FORMULA_LINES ["中","PP","HH","M20"] expect 4 = 4`。

## 十字线：横纵同时响应
新增 `moveCrosshairBoth(x, y)`（行 1672），`onPointerMove` 分时 locked 态直接调它，
`state.crossY` 与 `state.crosshairIdx` 同一帧写入。原来「首次移动锁单轴」的方案废弃。
`verify27.mjs` 实测：
- `CROSS_DIAG vX 195->231 (d36) | hY 164->224 (d60)`
- `CROSS_VERT vX 231->231 hY 224->267`（纯纵拖不动横）
- `CROSS_HORIZ vX 231->283 hY 267->262`（纯横拖横线抖动 5px，为手感容差）

## 越界重绘验证（第四轮已改为轻量 setOption）
`updateTimelineTail` 里比对当前 yAxis 的 min/max 与实时极值（含均价线），越界时**不再整图重绘**，
只 `setOption({ yAxis:[{min,max,interval}] })` 改价格轴，网格与 series 全部原地保留。
早先的 `paintTimeline` + 2 秒节流 `state.lastAxisFixAt` 方案已废弃——tick 本身就 3 秒一次，
节流形同虚设；而不节流又会在盘中单边上行时每 tick 重建整图，屏上一路闪。
`verify28.mjs`（伪造 26.90 突破价，成交时间用 `150000` 落在 241 槽）实测：
- 前 `{"min":24.55,"max":25.87}`
- 后 `{"min":23.52,"max":26.9,"hi":26.9,"lo":25.39,"center":25.21}` → `SYMMETRIC true COVERS_HI true`

> 踩坑：第一版 verify28 用 `time:'20261019103000'`（10:30 槽位）伪造，`quoteMinute` 取到 1030，
> 但已有分时数据早已填到 15:00（`lastFilled` 更靠后），条件 `i >= lastFilled` 不成立被丢弃，
> 看起来像「越界重绘没生效」。改到 150000 才生效。

## 填充率 0.376 的重新解读
`verify27.mjs` 的 `FILL_RATIO 0.376` 并非算法缺陷：该股当日高开（昨收 25.21，最低 25.39），
价格全在昨收上方。中轴对称后下半边必然空一半——这正是通达信的真实画法。
截图 75 可见曲线在上半区顶到 yMax 25.87（=当日最高），贴边无余量，符合 HQChart 口径。

## 本轮实测
- `node --check` chart.js / app.js 通过；`npm test` 5/5
- yAxis `24.55 / 25.87`，interval 0.33，center 25.21
- series 8 条：PRICE,AVG,中,PP,HH,M20,VOL,RATIO（比上轮少 Z/M）
- 量比 n=242，首 0.8734、末 0.7049、峰 3.4083；1.0 基准 markLine 在
- 夜里 21:00 打开：12 秒内 `/api/quotes` 零新增请求
- 截图：`/tmp/uitest/shots/75-min-axis.png`、`76-min-cross.png`
- 差异：相对 `/tmp/bk-1020b/chart.js` 共 163 行增删，`/tmp/bk-1020/round3-chart.diff`（29826 bytes）

## 仍未收口
- 公式 `X`/`Y` 取值用户未定义，现用 `TL_PEAK_Y = 15`（=1.5%）近似；`X` 只喂 Z/M，已无意义。
- 纵轴刻度标签 0.33 间隔，中间一档会被 ECharts 自动隐藏（截图里只见 4 个值）。
- 无单测覆盖 `parseTimeline` / `timelineSeries` / `timelineFormulas` / `renderCrosshairMin`。

---

# 第四轮（2026-10-20）：审查修复 + 图例归位

## 修复清单（来自子 Agent code-review）
| # | 级别 | 问题 | 修法 |
|---|------|------|------|
| 1 | P1 | `scheduleQuotes` 探测轮被 `!marketClosed` 门禁吞掉，误判休市后当天永不自愈 | 引入局部 `probe` 标志，条件改 `(!marketClosed \|\| probe)` |
| 2 | P1 | `scheduleChartQuote` 同根因，误判后看盘分时图当天冻结 | 等待醒来的回调里只要 `inTradingWindow()` 就补拉一次 |
| 3 | P2 | `renderTimelineLegendAt` 把「中」「M20」写进量比行，锁定/解锁两态图例来回跳 | 改成与 `renderTimelineLegend` 相同的三行结构 |
| 4 | P2 | 越界分支无条件 `return`，轴未真变时整轮数据/图例/十字线静默丢帧 | 删掉 `return`，落到正常增量更新流程 |
| 5 | P3 | `state.gridRects = slot.rects \|\| state.gridRects` 短路方向反了 | 改为 `if (slot.rects && slot.rects.length)` |

另有两处衍生清理：
- `renderTimelineLegend` 与 `renderTimelineLegendAt` 里删掉了「涨跌」项及随之无用的 `chg`/`chgCls`/`prevClose` 局部变量。
  顶部行情条已显示 `+0.41 / +1.63%`，图例再摆一遍只占宽度，会把 `M20` 挤到第二行。

## 图例归位
价格 panel 图例行现在是 7 项一行：`价格 / 均价 / 中 / PP / HH / M20`，
VOL 单独一行（`VOL / 最高 / 最低`），量比单独一行。
`buildGrids` 按 panel 分别预留图例高度，价格 panel 预留 2 行、其余各 1 行。
`lg2.mjs` 实测三行 `top 0/374/513`，行高均 14，量比行文本 `量比 0.70`。
截图 `/tmp/uitest/shots/78-legend-final.png`（盘中 10:30 模拟，390×844）、`79-legend-cross.png`。

## 十字线坐标与竞态（已核实无问题）
- `moveCrosshairBoth` 内 `clientY - canvas.getBoundingClientRect().top` 与 `renderCrosshairMin` 同一坐标系；
  锁定态 cross 分支有 `state.period === 'min'` 守卫，不会误吞日线手势。
- `api.load` 入口 `++tlToken` + `hideCrosshair()`；`refreshTimeline` 侧 `token !== tlToken` / `state.code` / `state.period` 三重校验。
- 轴区间变化后 `state.crossY` 用 `minValueAtY` 取价格锚点、`minYAtValue` 映射回像素，带 `isFinite` 与 grid 钳位。

## 本轮实测
- `node --check` chart.js / app.js / server.js `ALL_OK`；`npm test` `pass 5 fail 0`
- `verify26`：`GRIDS [{top:30,h:333},{top:391,h:111},{top:530,h:111}]`、`SERIES ... count 8`、
  `YAXIS 24.55 25.87 interval 0.33`、`RATIO n=242 min 0.7014 max 3.4083`、`CROSS_DRAG 164→224 moved 60`、
  `NIGHT_QUOTES initial 2 after_12s 2 extra 0`
- `verify27`：`FORMULA_LINES ["中","PP","HH","M20"] expect 4 = 4`、`PREV_CLOSE_MARKLINE 25.21`、
  `CROSS_DIAG 195→231 / 164→224`、`CROSS_VERT`、`CROSS_HORIZ` 双向均生效
- `verify28`：`AXIS_AFTER_BREAKOUT {"min":23.52,"max":26.9,...}`、`SYMMETRIC true COVERS_HI true`
- `verify30`：`REQ afterLoad 1 afterOpen 3 afterIdle20s 3 extra 0`（非交易时段无多余轮询）
- 文件大小：`chart.js 102217`、`app.js 61105`、`index.html 9899`、`src/server.js 39675`、`quotes.js 9533`
- 相对 `/tmp/bk-1020/` 备份：chart.js 约 570 行、app.js 约 75 行差异
- 已知无害：`manifest.webmanifest 404`（既有问题，与本轮无关）

## 第五轮：独立审查收口 + 量比口径修正
- 子 Agent `poEyL5Fh` 基于最新版（chart.js 102217 / app.js 61545 / server.js 39249）做只读 code-review，
  结论「**可以发布**」：无 P1；通达信对称轴、双轴十字线、量比副图、公式线只画 `:` 输出、
  非交易时段零请求与自愈路径逐条核验成立，token 竞态闭环完整。
- 两条实质项处理：
  1. `daily_kline.date` 格式契约已核实为 `YYYY-MM-DD`（实测 `sz000807` 返回 `"2026-10-19"` 等），
     与 `toISOString().slice(0,10)` 同格式，剔当日逻辑正确 → 仅补注释固化契约。
  2. 量比分母口径偏差确认存在并修正：原 `sum / n`（n = 有成交天数）在停牌多的票上
     分母被抬高、量比系统性偏低；改为 `sum / use.length`（交易日数，停牌日按 0 计入，新股按实际天数）。
     实测 5 只样本 300 行无零成交量行，常规票新旧口径数值相同（`439428.54`），仅异常票有差异。
- `src/server.js` 39249 → **39675 bytes**；`node --check` OK；重启服务 pid 791875，`0.0.0.0:3100` LISTEN，
  `/api/health` `{"ok":true,...}`。
- 审查中其余条目均为有意取舍或可接受边界（09:30 首分钟量比尖刺与通达信 FROMOPEN=1 一致；
  `closedWaitMs` 在 11:30/15:05 窗口边界可能静默丢一轮探测，下一窗自然恢复；
  `buildGrids` 在 <200px 画布上价格区被压窄属极端小屏；PP 的 `TL_PEAK_Y = 15` 为自定参数、
  与通达信 ZIG 仅为语义近似）。
- 重启后已是 09:16 集合竞价，分时仅 1 个点，`verify26` 的 `RATIO n=1`、`FILL_RATIO 0` 属当时刻正常现象；
  `verify27` 仍 `FORMULA_LINES expect 4 = 4`、`PREV_CLOSE_MARKLINE 25.62`、十字线三向均生效；
  `verify30` `extra 7` 因当时处于交易窗口内，非回归。
- 五轮累计：分时图 5 项需求全部落地并经独立审查确认可发布。
