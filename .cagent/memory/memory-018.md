---
id: memory-018
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-28T23:38:57+08:00
updated: 2026-09-28T23:38:57+08:00
importance: high
category: 其他
keywords: [stock-picker, precompute, table-schema, weekly_kline, daily_indicators, suspended-fill, volume_ratio, qfq]
summary: stock-picker 预计算表最终 schema 与三个必须修的口径细节：daily_indicators 需含 close 字段供实时补齐 MA 用；停牌日 close 用前一日填充对齐通达信而非跳过；volume_ratio 必须覆盖 5/10/20/60 四个长度而非写死 5；复权只跑 qfq 省 66% 存储。
---
最终表设计（写入 kline.db）：
- daily_indicators：code, date, open, high, low, close, vol, amount, ma5, ma10, ma20, ma60, vr5, vr10, vr20, vr60；close 字段是关键，实时补齐当日数据时要用它做 MA 滚动重算，若没有得回查 daily_kline 白预计算了。
- weekly_kline：code, week_start, open, high, low, close, vol, amount, trade_days；只有完整周（含周五或以前的周）。
- weekly_indicators：与 daily_indicators 相同指标列，但只存 close/vol/ma/vr（OHLC 从 weekly_kline join）。
- precompute_meta：key/value 存 schema_version 和 last_completed_date，用于增量触发。
口径细节：
1) 停牌日 close 用前一日填充（对齐通达信），vol 归零（无成交事实），不能用 filter(finite) 直接删掉停牌日——会跟 TDX 结果有差异。
2) volume_ratio 预计算 4 列（vr_5/10/20/60），因为默认策略用 length=20、其他策略可能 5/10/60，写死 5 会漏。
3) 复权只跑 qfq，省 66% 存储和 66% 预计算时间，覆盖 99% 场景；hfq/raw 以后要加再加。
4) 主键用 (date, code) 而非 (code, date) 全市场扫描更快。
实测数据：5574 只股票、11965955 行日指标、1993000 行周指标，全量预计算约 2 分钟。
