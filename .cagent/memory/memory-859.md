---
id: memory-859
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T09:46:26+08:00
updated: 2026-11-22T09:46:26+08:00
importance: high
category: 约束限制
keywords: [free-stockdb, 数据源选型, 1分钟OHLC, 北交所, 静默漏数据, 镜像, 起始年份]
summary: free-stockdb经核实不能作为股票回测主力数据源，存在四个硬伤：仓库无数据只发引擎、1分钟起始年份自相矛盾、无北交所覆盖证据、第三方实测有静默漏数据。
---
free-stockdb（hello245m）核实结论：1）仓库本身不含任何数据，只包含C++同步器源码，数据需从外部镜像节点同步（manifest.txt+SHA-256校验），镜像由发布者自建，来源不透明；2）1分钟历史起始年份官方README完全不提，第三方fork写'2000年起'但与'1.1亿条'总量在数学上冲突（5400只×240根/天×243天≈3.1亿根/年），结合项目2026-05-08创建，判断1分钟线极可能只有2026年内数据；3）全仓库、README、issue均无'北交所/京市/920/bj'任何字样，覆盖存疑；4）CarrotQuant.Data项目README原文警告：'实测StockDB 0.3.5版本存在静默截断、TCP通信丢包、半包粘包等底层数据异常及静默漏数据错误，不推荐使用'。结论：适合快速搭雏形，不适合真实历史分钟OHLC严谨回测。
