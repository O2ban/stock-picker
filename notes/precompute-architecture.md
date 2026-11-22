---
title: 预计算架构方案 v2
category: 运行与发布
date: 2026-09-28
updated: 2026-09-28
status: active
tags: []
summary: 2026-09-28 23:20 上一版方案经过评审，需要修正三处硬伤、确认几个关键技术取舍。本文档 v2 是最终版本，实施依据。 把选股从「实时聚合 + 现算指标」改造为「预计算…
---

# 预计算架构方案 v2

## 记录时间

2026-09-28 23:20

## 背景

上一版方案经过评审，需要修正三处硬伤、确认几个关键技术取舍。本文档 v2 是最终版本，实施依据。

## 目标

把选股从「实时聚合 + 现算指标」改造为「预计算查表 + 基准日/实时补齐」，让全市场选股从当前 33.7 秒降到 1–2 秒，达到通达信同花顺级别的响应速度。

## 数据现状（实测）

- kline.db: daily_kline 表 942 万行、5566 只股票、覆盖 2018-01-02 至 2026-09-18
- 每只股票约 2116 个交易日（8.8 年）
- 已有索引：idx_kline_date(date)、idx_kline_code_date(code, date)、主键 (code, date)
- 目前无周线表、无指标表

## 关键决策（已拍板）

### A. 数据库位置 → **独立 indicators.db**

- 路径：/home/ubuntu/stock-picker/indicators.db
- 理由：
  1. kline-trainer 也在写 kline.db，两个写方抢锁会互相拖慢
  2. 物理隔离零冲突
  3. stock-picker 读两个库：kline.db（原始日线）+ indicators.db（预计算结果）
  4. 用户之前说"复用 kline-trainer 的 kline.db"是指**读**，现在写的是新表，不冲突原意

### B. 复权 → **只跑 qfq**

- 省 66% 存储和 66% 预计算时间，覆盖 99% 场景
- hfq/raw 以后要加再加

### C. 量比组合 → **vr_5 / vr_10 / vr_20 / vr_60**

- 覆盖 99% 策略（默认策略用 20，量比 5 常见于短线）
- 其他 length 走兜底：引擎检测到策略 length 不在预计算集合内时，回退到实时算（当前 engine.js 的 indicatorResult 逻辑）

### D. 停牌日处理 → **前值填充**

- 通达信口径：停牌日用前一日 close/vol/amount 填充
- 不是 filter(finite) 直接删掉，那样 MA 会漏掉停牌日的数据点

## 表结构（最终）

### daily_indicators 表

```sql
CREATE TABLE daily_indicators (
  date TEXT NOT NULL,           -- 交易日期 YYYY-MM-DD
  code TEXT NOT NULL,           -- 股票代码
  close REAL NOT NULL,          -- 收盘价（qfq，实时补齐用）
  ma_5 REAL, ma_10 REAL, ma_20 REAL, ma_60 REAL,   -- 日 MA
  vr_5 REAL, vr_10 REAL, vr_20 REAL, vr_60 REAL,   -- 量比 = 当日 vol / 前N日均量
  momentum_5 REAL, momentum_10 REAL, momentum_20 REAL,  -- 动量 = 当前 / N日前 - 1
  trend_strength REAL,                              -- 趋势强度 = (close-min)/max * 100，N=20
  PRIMARY KEY (date, code)
) WITHOUT ROWID;

-- 支持"给定日期查全市场"的快速扫描
CREATE INDEX idx_dind_date_code ON daily_indicators (date, code);
```

- 约 5574 × 2116 = 1179 万行 × ~12 列 ≈ 700MB
- 主键 (date, code) 而非 (code, date)，因为选股场景是"全市场按日期扫"

### weekly_kline 表

```sql
CREATE TABLE weekly_kline (
  week_start TEXT NOT NULL,     -- 该周周一日期 YYYY-MM-DD
  code TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  vol REAL,
  amount REAL,
  PRIMARY KEY (week_start, code)
) WITHOUT ROWID;

CREATE INDEX idx_wk_week_code ON weekly_kline (week_start, code);
```

- 约 450 周 × 5574 ≈ 250 万行 ≈ 100MB
- 只存**完整周**（周一到周五全都有）；本周未结束的由实时补齐路径处理

### precompute_meta 元表

```sql
CREATE TABLE precompute_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 记录 schema 版本、上次预计算日期、行数等
```

## 引擎改造

### 扫描逻辑（伪代码）

```js
function runScreenPrecomputed(strategy, options) {
  // 1. 计算扫描窗口
  const scanEnd = options.referenceDate || today();
  const scanStart = daysBefore(scanEnd, options.scanWindowDays || 90);
  
  // 2. 加载股票列表（universe 过滤）
  const stocks = filterUniverse(listStocks({board, excludeSt}), options);
  
  // 3. 批量查询：一次拿扫描窗口内所有股票的预计算指标
  const rows = queryIndicators({
    dateStart: scanStart,
    dateEnd: scanEnd,
    codes: stocks.map(s => s.code)
  });
  
  // 4. 实时补齐（如果 scanEnd == today && today 未收盘）
  if (options.realtime && !isAfterMarketClose()) {
    rows = mergeTodaySnapshot(rows, queryTodayDaily(stocks));
  }
  
  // 5. 周线指标：查 weekly_kline 表（+ 本周实时状态）
  const weeklyData = queryWeeklyIndicators({
    dateStart: scanStart,
    dateEnd: scanEnd,
    codes: stocks.map(s => s.code),
    realtime: options.realtime
  });
  
  // 6. 遍历计算：查表命中，不再 loadRows 日线
  for (const stock of stocks) {
    const stockRows = rows.byCode(stock.code);
    const weeklyStockRows = weeklyData.byCode(stock.code);
    
    for (const cond of strategy.all) {
      const r = evaluateConditionFromPrecomputed(cond, stockRows, weeklyStockRows);
      if (!r.pass) { failed = true; break; }
    }
    if (failed) continue;
    
    // 评分
    let score = 0;
    for (const s of (strategy.score || strategy.all)) {
      const r = evaluateScoreFromPrecomputed(s, stockRows, weeklyStockRows);
      score += r.score * s.weight;
    }
    // ...
  }
}
```

### 兜底机制

如果策略用到不在预计算集合内的指标组合（比如 length=37），当前策略引擎的实时计算路径仍保留作为 fallback。

## API 契约

### POST /api/screenings 请求体扩展

```json
{
  "strategyId": "xxx",
  "adjust": "qfq",                          // 默认 qfq，只支持 qfq
  "scanWindowDays": 90,                     // 默认 90（3 个月）
  "referenceDate": "2026-09-18",            // 可选，默认今天
  "realtime": true,                         // 默认 true，referenceDate==today 时生效
  "universe": {
    "board": null,
    "excludeSt": true,
    "limit": null
  }
}
```

### POST /api/precompute（新增，同步）

- 参数：无（默认全量重算）
- 60 秒同步执行不现实，改成异步
- 返回：{ jobId, status: "running" }

### GET /api/precompute/status（新增）

- 返回：{ lastRunAt, lastRunDuration, currentJob, currentJobProgress }

### GET /api/precompute/:jobId（新增）

- 查询某个预计算任务进度

## 实时补齐算法

1. 判断 referenceDate 是否是"未收盘的当天"
2. 若参考日已收盘：直接用预计算表数据
3. 若参考日未收盘：
   a. 从 daily_kline 查今日每只股票的 open/high/low/close/vol/amount
   b. 与预计算的**前一日**（referenceDate - 1 交易日）拼合
   c. 重算 MA、量比、动量、趋势强度
   d. 用于当日的选股评估

## 性能预期

- 单次全市场扫描：SELECT 从 indicators.db 查 90 天 × 5574 只 = 50 万行，SQLite 索引命中 < 500ms
- 周线查询：90 天对应约 18 周 × 5574 只 = 10 万行 < 100ms
- 引擎遍历 50 万行做条件判断：< 500ms
- 实时补齐 5574 只股票：~1 秒
- **总耗时目标：1–2 秒**

## 实施顺序

### Phase 1：基础设施（预计 30 分钟）
- [ ] 创建 indicators.db 文件
- [ ] 建 daily_indicators、weekly_kline、precompute_meta 表
- [ ] 编写 precompute.js 脚本（独立可执行）

### Phase 2：预计算脚本（预计 60 分钟）
- [ ] 全量日线读入 → 逐股计算所有指标 → 写 indicators.db
- [ ] 全量日线聚合 → 周线表
- [ ] 停牌日前值填充
- [ ] 增量模式：只算新交易日
- [ ] precompute_meta 记录进度
- [ ] 100 只股票端到端验证

### Phase 3：引擎改造（预计 60 分钟）
- [ ] engine.js 新增 runScreenPrecomputed
- [ ] 保留原 runScreen 作为 fallback
- [ ] API 参数扩展
- [ ] 前端参数（暂不做，先保证 API 通）

### Phase 4：定时任务 & 运维（预计 30 分钟）
- [ ] 每小时 cron：检查是否有待完成任务
- [ ] 收盘后自动预计算
- [ ] 手动触发端点

### Phase 5：测试 + 发布（预计 30 分钟）
- [ ] 单元测试
- [ ] 真实环境端到端测试
- [ ] 性能基准测试（对比改造前）
- [ ] 发布

## 已知风险与兜底

1. **kline-trainer 抢锁**：indicators.db 独立，零冲突
2. **策略用 length=37**：fallback 到实时算，性能差一点但功能不错
3. **首次全量预计算 30+ 分钟**：接受，用 CLI 独立跑，不阻塞 server
4. **盘中实时补齐延迟**：接受 1–2 秒补齐开销
5. **复权变化**：qfq 随分红会变化，每次分红后需要重跑预计算

## 用户授权

2026-09-28 23:18 用户明确要求"直接实施到底，并自行测试和最终发布，在真实环境测试。定一个每小时定时任务检查笔记继续推进，防止中途断连"。全程自主推进，无需再确认。
