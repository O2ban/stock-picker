---
id: memory-567
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T06:58:40+08:00
updated: 2026-10-21T06:58:40+08:00
importance: medium
category: 方法经验
keywords: [restoreLegendLatest, hideCrosshair, 取消十字线恢复, K线取rows.length-1, renderQuote同恢复]
summary: 取消十字线恢复最新的实现要点：hideCrosshair 内先 state.locked=false 再调 restoreLegendLatest，K 线分支必须用 slot.rows.length-1 且同时调 renderQuote(last)（因为 renderCrosshair 的 K 线分支本身会改行情条），否则顶部价格/涨跌/最高最低/成交额仍停在历史那天。
---
stock-picker 取消十字线后恢复最新读数的正确姿势：restoreLegendLatest 只应由 hideCrosshair 调用，且 hideCrosshair 先置 state.locked=false 再恢复，避免与 renderCrosshairMin（只在 locked=true 时执行）冲突。分时分支走 renderTimelineLegend/renderTimelineQuote 最新点；K 线分支必须 renderLegend(slot, slot.rows.length-1) + renderQuote(last)，等价于 render() 的 state.klines.length-1 默认口径。关键易漏点：日 K 十字线点在历史某天时，不仅下方指标变成那天，顶部价格/涨跌/最高最低/成交额也会一起跳到那天（因为 renderCrosshair 的 K 线分支末尾调了 renderQuote(index)），所以恢复时必须把行情条一起恢复，否则用户看到顶部仍是历史数据。调用图核查：hideCrosshair 仅被 toggleCrosshair、api.open、api.load、renderCrosshair/renderCrosshairMin 的边界保护调用；3 秒 tick 的 updateTimelineTail/updateKlineTail 在锁定态走 renderCrosshair 不会触发 hideCrosshair，不存在每 tick 重画问题。api.open 里 hideCrosshair 在 api.load 之前用旧数据画一次，随即被 applyPayload→paint 覆盖，窗口极短不可见。
