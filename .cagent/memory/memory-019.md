---
id: memory-019
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-28T23:38:57+08:00
updated: 2026-09-28T23:38:57+08:00
importance: medium
category: 其他
keywords: [stock-picker, kline-db-reuse, database-decision, qfq-only, no-separate-db]
summary: stock-picker 数据库策略：必须复用 kline-trainer 的 kline.db 绝不单独建 indicators.db，复权只处理前复权（qfq）。
---
用户明确约束（两次重申）：
1) '数据库必须坚持复用，绝不能单独搞一套'——预计算表直接写入 /home/ubuntu/kline-trainer/kline-server/data/kline.db，不建 indicators.db。虽然评审建议独立库避免与 kline-trainer 抢写锁，但用户优先数据源统一。
2) '复权一般都是只考虑前复权吧'——只跑 qfq，不跑 hfq 和 raw。
配合策略：预计算脚本用 WAL 模式 + 按股票分批 + 短事务，减少与 kline-trainer 的锁冲突窗口；实际运行期间确保 kline-trainer 未跑（先 ps 检查）。
