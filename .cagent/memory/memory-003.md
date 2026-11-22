---
id: memory-003
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T10:45:15+08:00
updated: 2026-09-21T10:45:15+08:00
importance: medium
keywords: [量价指标, 预计算, 数据库字段, kline-schema]
summary: 选股需要的量价指标（价格均线、量能均线等）通过服务端程序自动计算写入数据库，前端不重复计算。
---
选股数据需支持量价维度：价格均线（如MA5/MA10/MA20等）、量能均线（如VMA等）。这些指标通过服务端程序自动计算后写入SQLite，数据库应扩展相应字段。如果API接口能提供直接下载则优先使用，没有的才考虑服务端计算。日线、周线、月线均需分别聚合和预计算指标。
