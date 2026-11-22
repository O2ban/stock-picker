---
title: 看盘实时价 + 列表涨幅排序（2026-10-19）
category: 运行与发布
date: 2026-10-19
updated: 2026-10-19
status: active
tags: []
summary: 1. 横滑换股后主图不显示实时最新价（打开第一只正常，滑动后不显示）。 2. #watch-list、#results-body 增加按涨幅排序。 问题：openChart 打开时…
---

# 看盘实时价 + 列表涨幅排序（2026-10-19）

## 需求
1. 横滑换股后主图不显示实时最新价（打开第一只正常，滑动后不显示）。
2. `#watch-list`、`#results-body` 增加按涨幅排序。

## 实时价修复（app.js）
问题：`openChart` 打开时会 `applyQuote(quoteMap.get(code))` + `refreshQuotes([code])` 再 `applyQuote`，
但 `tdx:switch`（横滑换股）只 `open` 新票，没有补行情，新票在 `quoteMap` 里可能还没有当日行情，
或 `api.load()` 回源后把已并入的实时价整体替换掉，表现为停在上一交易日收盘。

修法：`tdx:switch` 里对新 `openCode` 走与 `openChart` 相同两步：
先 `applyQuote(quoteMap.get(code))`，再 `refreshQuotes([code]).then` 后带
`if (openCode !== code) return;` 守卫二次 `applyQuote`。
守卫是必须的：快速连续横滑时早先那只的回填会串进新图。

`chart.js` 侧 `applyQuote` 本身要求 `state.period === 'day'`，
周/月线不并入实时价是既有设计（并入会算坏聚合柱指标），不是 bug。

## 排序（app.js / index.html / styles.css）
- 状态 `sortMode = { watch:'', screen:'' }`，三态循环 `'' → desc → asc → ''`，不持久化。
- `orderedList(list, mode)`：拷贝后按 `quotePct` 排，**无行情的排最后**（首帧不乱跳），空值对称返回 0。
- 排序只改渲染顺序，不回写 `watchList` / `screenRows`，因此 localStorage 的自选顺序不受影响。
- `syncNeighbors` 也过 `orderedList`，保证横滑邻票 = 眼睛看到的列表下一只。
- `syncSortOrder()`：每分钟行情后对比 DOM 实际顺序与目标顺序，**只在真的不一致时才重渲染**，
  避免每分钟白重建 DOM 把滚动位置顶掉。

## 本轮补的两个坑（子代理 code-review 指出）
排序开启后若靠「分钟行情自动重排」触发重建，这条路径没有收尾：

1. **迷你 K 线集体消失**：`buildList` 用 `innerHTML` 重建 `<li>`，所有 `canvas[data-spark]` 是新空白画布，
   而 `drawSparks()` 原来只在 `loadKlines` 里调用，行情轮询路径不会走到。
   → 在 `renderWatch()` / `renderScreen()` 的 `buildList` 之后统一补 `drawSparks()`，
   覆盖所有重建入口（切排序、刷新、自动重排），不依赖调用方记得补。
2. **自动重排后邻票不更新**：`syncNeighbors` 原本只在 `openChart` / `tdx:switch` / `cycleSort` 调，
   分钟行情重排后 `state.neighbors` 仍是旧顺序。
   → `syncSortOrder()` 里 `rerendered` 为 true 且有 `openCode` 时补 `syncNeighbors(openCode)`。

## 验证（/tmp/uitest/verify23~25.mjs）
- verify23：排序前后 / 升序 / 刷新后，4 只迷你 K 线 `painted:true`；排序后首个横滑 = 列表下一只 `MATCH true`。
- verify24：mock 反转 pct 触发自动重排，`AFTER_TICK_REORDER` 顺序全反且 sparks 全 `true`；
  打开末位股票时无下一只，滑不动属预期。
- verify25：打开中间那只 `sh600519` → 重排后 `EXPECT_NEXT sz000807`，横滑 `MATCH true`，
  主图尾柱 `lastDate 2026-10-19`、`lastClose 25.78` 与 `/api/quotes` 实时价一致 `PRICE_MATCH true`。

## 注意
- 前端 `public/` 文件按请求实时读盘，改完刷新即生效，**无需重启服务**。
- `/api/quotes` 返回体字段是 `items`（不是 `quotes`），mock/断言时容易踩。
