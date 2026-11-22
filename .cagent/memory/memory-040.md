---
id: memory-040
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T22:38:34+08:00
updated: 2026-10-15T22:38:34+08:00
importance: medium
category: 其他
keywords: [stock-picker, startup-init, init-path-conflict, syncStrategyBar, applyHistoryItem, loadStrategyLibrary, state-desync]
summary: stock-picker 启动序列有两条策略初始化路径会打架：loadStrategyLibrary() 先选中首项并同步设置页，随后 applyHistoryItem(historyItems[0]) 经 syncStrategyBar() 改 select.value 不派发 change，导致选股页与设置页策略不一致。
---
根因是启动时先执行 loadStrategyLibrary() 把策略栏选到首项并同步设置页编辑器，再执行 applyHistoryItem(historyItems[0]) 恢复最新历史，后者调 syncStrategyBar() 只改 select.value 不派发 change（且未同步 currentStrategyId/filterStrategyName），使选股页列表显示历史策略、设置页名称框仍是首项。修复需在 syncStrategyBar 的命中分支补齐状态同步并显式派发 change，且确认程序派发的 change 不会回环再次调用 syncStrategyBar。这类『两条初始化路径写同一 UI 状态却只同步一半』是启动期状态不一致的典型模式。
