---
id: memory-677
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T22:46:24+08:00
updated: 2026-11-19T22:46:24+08:00
importance: medium
category: 用户习惯与关切
keywords: [trend-mark-not-threshold, no-shrinking-pool, freshness-flag, verify-before-gate]
summary: 样本不足时，新发现的特征应做成『标记』让后续数据验证，而不是直接做成『门槛』把票数砍到个位数。
---
stock-picker 当前最大的问题是票数偏少（日均 10~26 只，冷清时可能为 0），因此任何新特征都不宜直接作为筛选门槛。用户思路（趋势向上能过滤下跌）经三年大样本复验后确实成立但极微弱：四层趋势全部向上（昨涨、5日涨、20日涨、60日涨）平均亏 0.11% vs 全市场亏 0.29%，仅改善 0.18 个点，而手续费是 0.26 个点，不足以翻身。因此正确做法是把『四层趋势全部向上』做成标记（打标的照常保留、不打标的不剔除），跑两三周后比较带标记与不带标记的实际表现。这个『弱信号先做标记后做门槛』的模式适用于所有样本不足、改善幅度接近成本的因子。
