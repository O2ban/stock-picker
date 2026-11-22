---
id: memory-451
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T09:27:23+08:00
updated: 2026-10-20T09:27:23+08:00
importance: medium
category: 方法经验
keywords: [切换周期, 十字线残留, hideCrosshair, locked, 状态清理]
summary: 从日线带着锁定十字线切到分时后，旧十字线和价签会残留，且 locked=true 会让第一次拖动走十字线模式而非换股，切换周期时必须显式 hideCrosshair 并清理锁定状态。
---
周期切换时的十字线状态清理：从日线带着锁定十字线切到分时后，旧的十字线和价签会残留，且因为 locked=true，用户第一次拖动会走十字线模式而不是换股，属于交互级 bug。修复是在切周期路径里显式调用 hideCrosshair 并复位 locked 等状态。凡是有『锁定/激活』型交互状态的可切换视图，切换时必须把该状态的清理写进切换函数，而不是依赖下一次用户点击自然覆盖。
