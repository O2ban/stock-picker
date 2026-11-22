---
id: memory-037
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T07:48:12+08:00
updated: 2026-10-15T20:32:35+08:00
importance: high
category: 其他
keywords: [stock-picker, static-file-realtime-read, no-build, no-release-script, restart-service-tool, cagent-vs-stock-picker]
summary: stock-picker 的 public/ 静态前端文件每次请求实时读盘，前端改动刷新即生效无需重启或构建；服务端 node 代码才需重启，且 restart_service 工具重启的是 cagent 对话进程而非 stock-picker，package.json 里也没有 release 脚本。
---
stock-picker 部署与重启的关键事实：
1. 服务端在每次请求时实时 `fs.readFile` 读取 public/ 下的静态文件，所以纯前端改动刷新浏览器即生效，不需要重启、不需要构建（项目也没有构建步骤）。
2. 服务以 nohup 方式运行（非 systemd/pm2），有 watchdog 每小时兜底探活。只有服务端 node 代码改动才需要手动重启进程。
3. `package.json` 里没有 `release` 脚本（只有 start/dev/test/check），所以对本项目走 release 既无产物可构建也无服务可换新。
4. **restart_service 工具重启的是承载当前对话的 cagent 进程本身，不是 stock-picker 的 node 进程**——对 stock-picker 改动调它等于空跑，还会掐断当前对话。

验收前端改动时，验证脚本直接打正在跑的服务即可读到最新代码。
