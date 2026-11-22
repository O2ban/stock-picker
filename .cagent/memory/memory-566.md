---
id: memory-566
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T06:58:40+08:00
updated: 2026-10-21T06:58:40+08:00
importance: medium
category: 方法经验
keywords: [10点量比, ratioAtTen, cum[30], 一过十点固定, 降级显示-]
summary: 分时图例「10点量比」的固化机制：10:00 前 s.ratio[30] 为 null 显示 '-'，10:00 当刻由 live quote 写入 cum[30] 并算出 ratio[30]，此后 live 覆盖只作用于 10:01 及更晚的槽，不碰 cum[30]，因此数值一过十点即固定不变。
---
10 点量比值固定在 10:00 的实现路径：后端在 10:00 前不产生该槽点（cum[30]==null → ratio[30] 保持 null），前端 ratioAtTen 返回 '-'。10:00 当刻若 live quote 命中槽 30，cum[30]=q.vol 被写入、ratio[30]=cum[30]/(perMin*30) 立刻算出；10:01 起 timelineSeries 重跑时 tl.byT 或 live 已固化 cum[30]，而 if (sameDay && i != null && i >= lastFilled) 的 live 覆盖只作用于 10:01 或更晚，不会碰 cum[30]。数值用 v != null && isFinite(v) 双重兜住 NaN，toFixed(2) 与主图例量比口径一致。已知非缺陷特性：10:00 首次由 live quote 写入 cum[30] 到后端下一次 30 秒校准用真实累计量覆盖之间，可能与后端 p.cumVol 差一笔成交，表现为一瞬间微小跳动后定住，属数据来源性质。
