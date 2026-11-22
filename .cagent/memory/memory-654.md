---
id: memory-654
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 方法经验
keywords: [参数可配置, 配置文件驱动, 硬编码例外, 策略参数]
summary: 日内策略参数已基本实现配置文件驱动（window/gap/gain/vol/shape/entry/mid/prevDay），残留硬编码仅 excludeLimitUp 的 9.8%、盯盘窗口 AUTO_DEFAULT、买点 label 的 45/190 与前端文案。
---
策略参数 100% 来自 strategies/*.json（除上述例外）。定时任务安全侧无定时器泄漏、无重复注册（if(timer) return + unref() + stopAutoWatch 成对），进程退出由 server.js 统一处理。排序三态逻辑（cycleSort/orderedList/renderSortBtn 的 ''→desc→asc→''）无 bug。这是该模块的整体健康度画像，可作为后续改动的前置认知。
