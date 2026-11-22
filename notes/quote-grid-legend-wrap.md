---
title: 成交量两位小数 + 顶部指标区/图例换行优化
category: 运行与发布
date: 2026-10-21
updated: 2026-10-21
status: active
tags: []
summary: 日期：2026-10-21 1. 日K/周K 成交量副图与顶部行情条成交量，万/亿单位保留两位小数。 2. 顶部指标区、图中图例的换行优化：消除「右侧还有空间、最后一项却被挤到下一…
---

# 成交量两位小数 + 顶部指标区/图例换行优化

日期：2026-10-21

## 需求
1. 日K/周K 成交量副图与顶部行情条成交量，万/亿单位保留两位小数。
2. 顶部指标区、图中图例的换行优化：消除「右侧还有空间、最后一项却被挤到下一行」的排版问题。
3. 日K/周K/分时三图统一处理。

## 改动
### chart.js
- `fmtVol`：万/亿由取整改为保留两位小数（原 `1.8万` 显示成 `1万`，量级失真）。分时小单量仍走整数分支，不显示 `.00`。
- 新增 `fillQuoteGrid(grid, items)`：离屏探测每项真实宽度 → 从满行数往下试每行能放几项 → 多行时尽量摊匀（7 项两行排 4+3，不是 5+2）→ 用 `.q-row` + `grid-template-columns:repeat(n,max-content)` 渲染。
- `renderTimelineQuote`（分时）、`renderQuote`（日K/周K）改为调用 `fillQuoteGrid`，不再拼固定 flex 的 innerHTML。

### chart.css
- `.chart-quote` 由 flex 改 block，价格区独占整行；`.q-grid` 改 block，`.q-row` 用 grid。
- `.chart-legend-row` 间距 `gap 0 8px→0 4px`、`padding 0 5px→0 2px`。
- 新增 `@media (max-width:340px)`：`gap 0 3px`、`font-size 8.5px`、色块 `margin-right 3px`。原因：320~340 窄屏分时第一行 6 项在 9px+4px 下超出几像素，M20 会被挤到第二行并压到图面（图例高度只按一行预留）。

## 验证
- `node --check public/chart.js` → SYNTAX_OK
- `npm test` → 5 pass / 0 fail
- Puppeteer 多视口（320/360/375/390/430）：
  - 行情条：日/周 7 项排 4+3，分时 6 项排 3+3，右侧无大片留白，无孤立项。
  - 图例：日/周/分时三周期均单行，`lines:1 h:14`；W=320 分时第一行修补后由 2 行 24.3px 回到 1 行 14px。
  - 成交量显示 `1.57万`、`7.39万`（两位小数）。
- 截图：`/tmp/uitest/t-{day,week,min}-{320,390}.png`，服务 127.0.0.1:3100 返回 200。

## 备份
- `/tmp/chart.js.bak-1219`（126643B）、`/tmp/chart.js.bak-1238`（128901B）
- `/tmp/chart.css.bak-1219`（9055B）、`/tmp/chart.css.bak-1238`（9808B）

## 收口补丁（12:52 后）
- `fillQuoteGrid` 加两道守卫：容器宽度为 0（抽屉未展开/隐藏）时跳过量宽、按每行全放退化处理，避免 `perRow` 算成 0 导致 `i += 0` 死循环；再加 `widths.length === list.length` 长度守卫。
- 宽度为 0 时改用 `requestAnimationFrame` 下一帧重排，避免七项被硬塞一行后裁掉。
- `node --check` → SYNTAX_OK；`npm test` → 5 pass / 0 fail。

## 最终差异规模
- `chart.js`：diff 135 行（3 个 hunk：分时行情条、fillQuoteGrid 新增段、日K行情条 + fmtVol）。
- `chart.css`：diff 53 行。

## 最终回归（12:55 复核）
- W=320/330/360/390 四档，日/周/分时共 12 组图例全部 `lines:1 h:14`，含 W=320 分时第一行 6 项（价格/均价/中/PP/HH/M20）。
- 行情条：日/周 4+3，分时 3+3，`free` 随屏宽线性递增，无孤项、无右侧大片留白。
- 成交量读数：日 `1.57万`/`7.39万`，图例 `VOL 1.57万 | MA5 3.71万`，均为两位小数。

## 遗留
- sw.js 版本 `sp-v7`，改动后需确认客户端缓存刷新策略（本次未动）。
  - 13:40 核实：sw.js 静态资源为 **network-first**（注释见第 4 行、实现第 63-71 行），改版即生效，**无需升版本号**。

---

# 分时换股「顶部数据区晚加载 / 跳变」排查与修复（13:35-13:50）

## 现象与责任划分（实测取证，非推理）
用 Puppeteer 探针分别对基线版本与改动版本跑同一套换股脚本，逐时间点采集 `#chart-quote` 的 height / q-main / q-row 文本。

| 现象 | 基线（改动前） | 本次改动后 |
| --- | --- | --- |
| `25.14 / -1306.74 / -98.11%` 混排帧 | 无 | **有（本次引入，已修）** |
| `1332 +6.91 +0.52% 2026-10-20` 昨日数据闪现 | 有 | 有（日K路径，既有现象） |
| 分时换股顶部区塌成 17px 空行 | — | 有（已修） |

- `-98.11%` 的算式：`25.14（云铝现价）− 1331.88（茅台昨收）= −1306.74`，占比 −98.11%。即**旧票行情按新股身份画进了顶部条**。
- 触发条件：`onPointerUp` commit 后，图表侧 `state.code` 已切到新股，而 app 侧 `openCode` 要等 `emitSwitch`（`PANE_SLIDE_MS` 后）才更新。这几百毫秒里在途的 3 秒轮询带回**上一只票**的 quote，此前无身份校验，直接画到顶部。

## 探针脚本本身的坑（重要）
`sw_probe.mjs` 用 `t === '分时'` 匹配周期按钮，但 `.seg` 的 `textContent` 是三按钮拼接（`分时日线周线`），**判断永不成立**，早期几轮「分时」测试实际全跑在日K上。后续改用 `#period-seg button[data-period="min|day|week"]` 直接点击，并回读 `button.active` 的 `dataset.period` 校验。
另：自选股 localStorage 键名是 `sp:watchlist:v1`，此前写成 `watchlist` 导致自选为空、`.stock-row` 等待超时。

## 改动（chart.js，共 5 处，diff 基线 `/tmp/chart.js.bak-1330`）
1. state 初始化新增 `previewTl: null`（约 274 行）——存邻票分时预取结果。
2. `renderTimelineQuote` 成交额缺失时保留格子显示 `-`（约 1284 行）——分时数据源不含成交额，若整格省略会少一行、高度 78→60 跳变。
3. `resetPreviewPane` 里 `state.previewTl = null`（约 1978 行）——防残留。
4. `preparePreview` 分时分支把已取到的 `date/prevClose/vol5/points/byT` 存进 `state.previewTl`（约 2008-2019 行）——**复用预览层已经画出来的同一份 payload，不新增请求**。
5. `onPointerUp` commit 分支：`period==='min' && previewTl.code===nb.code` 时立即写入 `state.timeline` 并 `renderTimelineQuote()`（约 2368-2382 行）；`applyQuote` 开头加 `if (q.code && state.code && q.code !== state.code) return;`（约 2438-2443 行）。

## 验证结果（390px，Chrome headless）
- 分时单次换股：`t+0` 起 `h:78` 全程稳定，价格立即为新票当日数据，成交额 200ms 内由 `-` 补成实际值。**无塌空、无错配。**
- 日K 单次换股：`h:78` 稳定；`t+0~t+120` 显示上一交易日收盘（与图中最后一根K线一致，缓存秒开的既有行为），`t+200` 起当日数据。
- 连续快速换股 3 次（间隔 250ms）：每次 `h:78`，`SETTLED` 显示工商银行 8.40 与其顶部数据完全一致，无错配。
- `node --check` → SYNTAX_OK；`npm test` → 5 pass / 0 fail。

## 备份
- `/tmp/chart.js.bak-1330`（129647B，本节所有改动前的基线）
- `/tmp/chart.js.dbg-hold`（131616B，含临时埋点，仅取证用，勿部署）
- `/tmp/chart.js.bak-dbg`（129647B，埋点写入前）

## 遗留
- 日K 换股瞬间的 200ms 昨日收盘闪现属既有缓存行为（行情条与图中K线自洽），本次未动；若要去除需给 K 线也做邻票首根 bar 预填，属新需求。
- 子代理只读审查（5 处改动）已派发，结果待收。

