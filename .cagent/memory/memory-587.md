---
id: memory-587
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:03:45+08:00
updated: 2026-10-23T20:03:45+08:00
importance: low
category: 错误教训
keywords: [maSafeToPrefilter, 无效守卫, 冗余代码, need公式, 预筛安全性]
summary: 为预筛加 MA 类指标安全守卫 maSafeToPrefilter 后发现该守卫对短窗数据恒返回 true（等于什么都没做），属于死代码，已删除——need 公式本身已保证安全。
---
预筛时担心 close_above_ma/volume_ratio 等在短窗最后一根（今日实时 bar）无预计算 MA 列时 sma 回退算出错值，于是加了 maSafeToPrefilter。实际验证发现：loadShortDaily + makeDailyMapper(false) 的数据根本没有 ma 列，prev 无 ma 即返回 true，守卫永远放行，是纯死代码。结论：安全性已由 conditionNeedBars 的 need 估算（保守 +2）覆盖，额外守卫只增复杂度，应删除。属于『防御性兜底可能是死代码』的又一实例。
