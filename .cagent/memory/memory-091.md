---
id: memory-091
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T00:10:07+08:00
updated: 2026-10-20T00:10:07+08:00
importance: high
category: 方法经验
keywords: [数据源选型, eltdx, pytdx, mootdx, 通达信, 取数客户端vs建库工具, 幸存者偏差]
summary: 评估通达信数据源时应先区分「取数客户端」和「建库工具」两类物种，并以 PyPI 最后发布时间而非功能描述判断库是否可用；kline 项目现有 eltdx 链路已是清单里最新最贴合 schema 的选择，不应换库。
---
评估通达信/行情数据源清单时，两个关键判据：(1) 清单里混着两种物种——取数客户端（eltdx、pytdxdata、tdxdata，负责从网络拿数据）与建库工具（tdx2db，负责把已下载文件变成数据库）。项目已完成建库层（951万行日线、raw/qfq/hfq三套复权、板块分类、增量断点续传、预计算表），再引建库工具是负收益。(2) 判断库的可用性要看 PyPI 实际最后发布时间：pytdx 停在 2019-08、mootdx 停在 2024-05 且底层就是 pytdx，tdxdata 总共只有 2 个版本。TQ 接口 tqcenter 依赖 GUI 客户端、官方数据包标注仅供券商后台，在 Linux 服务器上均不可行。清单里唯一有真价值的是 tdx2db 的「本地 vipdoc 读取可覆盖已退市股票」，能消除回测的幸存者偏差，但前提是有一份完整下载过盘后数据的通达信 Windows 客户端 vipdoc 目录。结论：不换库，真正值得推进的方向是分钟线能力扩展、退市股补全、采集链路冗余备份。另注意 eltdx 许可证是 Research-Only（禁止商用），对外服务/商业化前是硬约束。
