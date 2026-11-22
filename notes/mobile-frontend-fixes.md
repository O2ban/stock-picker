---
title: stock-picker 移动端前端修复与改造（2026-10-15）
category: 界面与交互
date: 2026-10-15
updated: 2026-10-15
status: active
tags: []
summary: public/ 目录为移动端 App 风格外壳（自选 / 选股双 tab + 下钻页 + 看盘抽屉）。 本次共 10 项修复/改造需求。 - 需求 1/2（预览消失）：buildL…
---

# stock-picker 移动端前端修复与改造（2026-10-15）

## 背景
public/ 目录为移动端 App 风格外壳（自选 / 选股双 tab + 下钻页 + 看盘抽屉）。
本次共 10 项修复/改造需求。

## 根因（已确认）
- **需求 1/2（预览消失）**：`buildList()` 用 `container.innerHTML = ...` 整段重建列表，
  旧 canvas 被替换为空白新 canvas；而 `loadKlines()` 发现 `klineMap` 已缓存该 code 时
  直接 return，跳过了 `drawSparks()`，新 canvas 没人画 → 预览空白。
  自选页「刷新」和选股页「最近三天」标签都走 `renderXxx() → loadKlines()` 这条链路。
  **已修**：`loadKlines` 命中缓存分支改为调用 `drawSparks()` 后返回。
- **需求 3（看盘显示昨天数据）**：两处根因
  1. `refreshQuotes()` 异步未 await 就读 `quoteMap` → 抽出 `tickQuotes()` 用 `await refreshQuotes()` 再读。
  2. `allCodes()` 截断 100 只，导致看盘股被挤出拉取名单 → 改为 `openCode` 优先加入名单；
     `refreshQuotes(codes)` 加可选参数支持指定代码；`openChart` 打开时立即 `refreshQuotes([code])` 再二次 `applyQuote`。

## 需求清单与状态
| # | 需求 | 状态 |
|---|------|------|
| 1 | 自选页刷新后 K 线预览消失 | ✅ 已修（loadKlines 缓存分支重画），截图核验通过 |
| 2 | 选股页「最近三天」标签后预览消失 | ✅ 已修，截图核验通过 |
| 3 | 看盘页实时股价刷新不稳定（有时显示昨天数据） | ✅ 已修（tickQuotes await + openCode 优先入名单），截图核验通过 |
| 4 | 选股说明移到底部 | ✅ 已完成（#screen-foot 移到底部），截图核验通过 |
| 5 | 「最近三天」标签移到选股说明行，横向滚动，默认选最新 | ✅ 已完成（.foot-scroll 包裹 + renderHistory active + 启动默认 applyHistoryItem(0)），截图核验通过 |
| 6 | 选股策略栏默认显示当前列表对应策略 | ✅ 已完成（syncStrategyBar 精确匹配 + saveHistory 记 strategyName），截图核验通过 |
| 7 | 修改策略名称后选股页联动更新保存 | ✅ 已完成（保存走 localStorage sp:strategy:v1 + loadStrategyLibrary 置顶 local:current），截图核验通过 |
| 8 | 策略说明与策略代码做成并列页签，默认说明 | ✅ 已完成（#strategy-tabs 两个 .st-tab/.st-pane），截图核验通过 |
| 9 | 去掉不起作用的校验按钮 | ✅ 已完成（#validate → #strategy-save 保存按钮），截图核验通过 |
| 10 | 看盘页日期放到涨幅后面 | ✅ 已完成（chart.js renderQuote），截图核验通过 |

## 关键文件（改动后行数）
- public/index.html（172 行）
- public/app.js（757 行）
- public/styles.css（289 行）
- public/chart.js（1019 行）
- src/server.js / src/quotes.js（后端只读参考）

## 重要决策
- 需求 7/8/9 的「保存」落到浏览器 localStorage（key `sp:strategy:v1` / `STRAT_KEY`）。
  原因：后端无策略修改接口（策略仅启动时从 `strategies/*.json` 读入内存 Map，重启即丢）。
- 原「校验按钮」功能被 `#strategy-save` 内部调用 `POST /api/strategies/validate` 取代。

## 验证方式（已做）
- `node --check public/app.js public/chart.js public/spark.js` 全通过。
- 用 puppeteer-core（/tmp/uitest/verify.mjs，390x844 视口）注入 localStorage 种子数据逐屏截图：
  1. 选股页默认选中最新历史 chip（10-15），下拉显示对应策略「日周趋势与量能（2 条）」。
  2. 切第 2 个 chip（10-14）→ 结果变为 sz000936，K 线 canvas 仍绘制（需求 2 通过）。
  3. 切第 3 个 chip → 策略栏显示「自定义测试策略」(run:current)（需求 6 通过）。
  4. 设置页两页签默认「策略说明」，切「策略代码」可编辑，保存成功提示「已保存」（需求 8/9 通过）。
  5. 保存后返回选股页下拉显示 local:current 并选中（需求 7 通过）。
  6. 看盘抽屉报价文本 `1313+26.97 +2.10%2026-10-15`，日期在涨幅后（需求 10 通过）。
  7. 自选页刷新前后 canvas 均 painted（需求 1 通过）。

## 遗留问题（与本次任务无关，待用户决定是否处理）
- `public/index.html` 第 14 行 manifest link 写死 `/stock-picker/manifest.webmanifest`，
  但 dev server 直挂根路径 `/` → 该请求 404，控制台反复报错。
  sw.js 第 19 行用的是相对路径 `./manifest.webmanifest`（正常）。
  需统一 manifest 路径策略（绝对 vs 相对），本次未擅改。

## 后端事实
- 策略库：`strategies/*.json`（当前 starter.json / low-suck-v2.json）+ 内存 Map。
  GET /api/strategies 返回 `[{id, name, conditions}]`。
- 行情：腾讯 qt.gtimg.cn，`src/quotes.js` 解析后有 `date` 字段。
- 选股：POST /api/screenings（读 body.strategy）→ 轮询 GET /api/screenings/:id。

## 第二轮：code-review 后的修复（2026-10-15 20:0x）
子代理 code-review 通读 app.js / chart.js / styles.css / index.html，报 12 条 findings，
其中 1 blocker + 3 major。逐条核实后，只修「本轮改动直接引入」的三处，另有一处自查发现：

1. **openChart 缺 openCode 守卫**（Finding 2，本轮需求 3 引入）
   `openChart` 的 `refreshQuotes([code]).then()` 里两次 `applyQuote` 未校验当前 openCode，
   快速 A→B 换股时 A 的行情会写进 B 的图。修：两次 applyQuote 前加 `if (openCode !== code) return;`。
2. **syncStrategyBar 用全角括号切名不可靠**（Finding 5，本轮需求 6 引入）
   原来用 `textContent.replace(/（.*$/, '')` 反推策略名，策略名本身含「（」时误匹配。
   修：给每个 option 挂 `dataset.name` 存原始名，匹配改读 `dataset.name`；`run:current` 选项也带 dataset.name。
3. **applyQuote 会把日线行情污染周/月线**（Finding 3，被本轮需求 3 放大）
   周线是周期聚合柱，塞一笔日线行情进去会把收/高/低/量算坏（MA/MACD/VOL 全错）。
   修：chart.js `applyQuote` 开头加 `if (state.period !== 'day') return;`。
   （顶部报价栏由 `renderQuote` 独立从 state.klines 渲染，不受影响，周线仍正常显示聚合价。）
4. **自查发现：策略栏与设置页错位**（本轮需求 7 引入）
   `loadStrategyLibrary` 把本地策略置顶并默认选中后，没回填设置页编辑器，
   出现「下拉显示 A、设置页显示默认 DSL」。修：选中后 `select.dispatchEvent(new Event('change'))`，
   复用已有的 change 分支回填编辑器/名称/板块/复权。

### 验证（第二轮）
- `node --check` app.js / chart.js / spark.js 全通过。
- `verify2.mjs`：含全角括号的策略名「缩量低吸（测试）」→ 下拉正确显示 local:current，无 run:current 误插。
- `verify3.mjs`：策略栏 / 设置页名称 / 编辑器 DSL 三者名称一致（PASS），无临时项。
- `verify4.mjs`（周期守卫探针）：日线注入假价 changed=true（生效），
  周线注入假价 changed=false（被忽略），周线报价栏仍正常显示聚合柱，符合预期。

## 第三轮：第二轮修复的复核（2026-10-15 20:0x）
对第二轮 4 处改动再派一次聚焦审查，报 1 处真实缺陷：

5. **`run:current` 占位项被当成远程策略 id 去请求**（Finding 2）
   策略栏里 `run:current` 是「历史记录的策略名在库里找不到」时的临时占位项。
   下拉 change 监听器只排除了 `local:current`，其余 id 一律走
   `GET /api/strategies/{id}`，于是选中占位项会去请求 `/api/strategies/run:current`，
   必然 404 进 catch 静默吞掉——既产生无用请求，语义也不明确。
   修：change 监听器开头加 `if (id === 'run:current') return;`，显式跳过占位项。
   注意：占位项不覆盖设置页编辑器是**预期行为**（它只表示「当前列表来自某次历史运行」，
   不是一份可编辑的策略），故下拉显示与编辑器不同名不是缺陷。

### 验证（第三轮）
- `verify5.mjs` / `verify6.mjs`：选中 `run:current` 后 `apiRequestsAfterSelect` 为空数组、
  `pageErrors` 为空 —— 守卫生效，不再产生 404 噪音。
- `node --check public/app.js` 通过。

## 发布说明（重要）
- 本项目 `package.json` **没有 `release` 脚本**，只有 `start` / `dev` / `test` / `check`；
  且 `public/` 静态资源由 `src/server.js` 的 `staticFile()` 每次请求 `fs.readFile` 实时读取、
  未设 Cache-Control，因此**前端改动刷新页面即生效，无需构建、无需重启**。
- `restart_service` 工具重启的是承载当前对话的 cagent 服务进程，**不是** stock-picker 的 node 进程
  （stock-picker 由 `nohup npm start` 拉起，另有 crontab 每小时第 5 分的 service-watchdog.sh 兜底探测）。
  故对本次纯前端改动调 `restart_service` 无意义，反而会掐断当前对话。

## 未处理（需用户批准，均为既有问题、非本轮引入）
- Finding 1（blocker）：`renderStrategySummary` 把用户可填的策略 JSON 里的 label/indicator
  直接拼进 `innerHTML`，存在存储型 XSS（仅影响本机自己的浏览器，但仍是隐患）。
  修法简单（复用已有 `escapeAttr`），但属既有代码、超出本次范围，**未擅改，待批准**。
- Finding 4/6/7/9/11/12：性能与同类 innerHTML 隐患，量级小，可后续处理。
- manifest 路径 404（见上「遗留问题」）。
