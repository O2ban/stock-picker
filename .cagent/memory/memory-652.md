---
id: memory-652
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: low
category: 错误教训
keywords: [策略说明, 文档口径不符, shape.look, shrinkRatio]
summary: 策略说明 JSON 的文字与代码口径不符：⑦「最多4根（约20分钟内）」实际4根约4分钟；⑥「缩到前堆3成以下」实际 shrinkRatio 是相对当日至今均量而非相对前一堆。
---
L3：intraday-strong.json 的 ⑤ 写「最近6分钟翻转不超过2次」与 shape.look=6 一致；但 ⑦「最多4根（约20分钟内）」中4根约4分钟；⑥「缩到前堆3成以下」实际 shrinkRatio 是相对「当日至今均量」不是相对前一堆。文档描述易误导后续改参数的人。
