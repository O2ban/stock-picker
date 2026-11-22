---
id: memory-051
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T13:05:44+08:00
updated: 2026-10-19T13:05:44+08:00
importance: high
category: 其他
keywords: [zombie-chrome-reaper, crontab, puppeteer-orphan, profile-cleanup, chrome-memory, 深挖根因, cron-env-simulation]
summary: cagent 所在 3.7G 机器上僵尸 Chrome 的根因是父脚本退出后被 init(1) 收养的 puppeteer/playwright 进程组以及 /tmp 下累积的孤立 profile 目录，已用 zombie-chrome-reaper.sh 每 15 分钟 cron 清理，笔记在 notes/chrome-memory-reaper.md。
---
内存压力排查结论：3.7G 机器上常驻多个半 G 级服务（deepseek-web-bridge 的 patchright worker 单进程 297MB、cagent-tauri main.mjs 472MB、stock-picker server 343MB、腾讯云 Java agent 603MB），Chrome 只是最显眼的部分；Swap 1315MB 长期未回收是体感卡顿的来源。孤儿进程根因是 uitest 测试遗留（node single2.mjs 退出后浏览器主进程被 init(1) 收养，10 个进程占 524MB）。清理脚本接入 crontab `*/15 * * * * /home/ubuntu/bin/zombie-chrome-reaper.sh`，同时清理无进程引用的 puppeteer/playwright profile 目录（判定条件：无进程引用 + 30 分钟内无写入）。脚本踩坑：pgrep -f 会误匹配 earlyoom 的参数；chrome 的 argv 被 prctl 改写导致按行取不到 --user-data-dir。改 crontab 前备份，并用 env -i 模拟 cron 精简环境试跑验证退出码。历史 OOM 全在 deepseek-web-bridge.service cgroup 内（memory.max=1.9GB），属涨到上限被自身 cgroup 杀掉而非撑爆整机，峰值仅 946MB，故暂不收紧限额。
