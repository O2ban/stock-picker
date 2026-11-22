---
id: memory-053
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T13:05:44+08:00
updated: 2026-10-19T13:05:44+08:00
importance: high
category: 其他
keywords: [codex_mode, agent-selector, applyAgentMode, opencode-missing-runner, hostMenuRef, cagent-chat-panel, menu-ref-containment]
summary: cagent 前端 agent 选择器（Cagent/Codex）通过 applyAgentMode 调 set-mode 写 codex_mode 字段，opencode 因后端无 runner 服务刻意未加入；机器菜单与 agent 菜单同开是 hostMenuRef 挂在外层容器导致 contains() 误判。
---
agent 选择器入口补回后调用链完整：点击 → applyAgentMode → set-mode API → 落库 codex_mode（切回 Cagent 时字段移除），界面状态与数据库一致。opencode 未加入菜单的原因：全仓仅在一个 Dashboard 分类名出现，which opencode 为空，也没有对应 runner 服务，凭空加会出现点了就报错的选项；真要加需写 server/services/opencode.ts 执行器 + 扩展 codex_mode 类型为 'codex'|'opencode' + 改 server/ipc/chat.ts 校验白名单 + 前端补项，约半天工作量。缺陷记录：hostMenuRef 挂在 hostBar 上而 agentGroup 是其子节点，点击 agent 触发器时 hostMenuRef.current.contains(target) 为 true，导致机器菜单不被关闭——ref 要挂到只包含自己菜单的节点上。单机模式下 agent 选择器用 margin-left:auto 右对齐，位置与多机时一致。验证深色主题时注意 App.tsx 会用 config.ui.theme 覆盖 localStorage 首屏值（既有权威配置行为），测试应直接设 <html data-theme> 而非改真实配置；evaluateOnNewDocument 对 about:blank 执行导致 localStorage 写入无效，需先 goto 再写入再 reload。
