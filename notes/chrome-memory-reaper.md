---
title: 孤儿 Chrome 清理与内存治理（2026-10-19）
category: 记忆与时间线
date: 2026-10-19
updated: 2026-10-19
status: active
tags: []
summary: 本机 vm-0-5-ubuntu 总内存 3723MB、Swap 1987MB，长期内存压力。dmesg 显示 2026-10-19 07:41–07:43 连续 3 次 cgro…
---

# 孤儿 Chrome 清理与内存治理（2026-10-19）

## 背景
本机 vm-0-5-ubuntu 总内存 3723MB、Swap 1987MB，长期内存压力。dmesg 显示 2026-10-19 07:41–07:43
连续 3 次 cgroup OOM kill，全部落在 `deepseek-web-bridge.service` 的 memcg 内，
被杀进程为 `chrome`（anon-rss 约 1.7–1.9GB）。该 cgroup `memory.max=1992294400`（1.9GB）。

## 处理结果（按时间）
| 班组 / 对象 | 规模 | 处理 |
|---|---|---|
| PID 140103 puppeteer 孤儿组 `profile-oInfem` | 11 进程 1549MB | 关闭，used 2261→1524MB |
| PID 1270649（9223 端口） | 9 进程 132MB | 关闭，端口释放 |
| PID 161217 `profile-SsP4yK`（uitest 残留） | 10 进程 ~524MB | 关闭 |
| `/tmp` 下已死 profile 目录 | 35 个 | 删除，/tmp 246→199MB |
| PID 63538 `deepseek-web-bridge` | 9 进程 ~500MB | **保留**（cgroup 保护） |

## 内存构成（清理后稳定态，used ~1.5–1.6GB）
- chrome（含 headless-shell）合计约 700MB：`playwright_chromiumdev_profile-lATIQH`（63538，bridge 用）约 500MB
  + cagent-tauri 的 headless_shell 约 298MB + cagent-shot 一次性约 90MB
- node 约 437MB（其中 cagent-tauri main.mjs 472MB 常驻、stock-picker server 343MB）
- MainThread 约 603MB（JVM 类进程 YDService/腾讯云 agent 等）
- Swap 1300MB 长期占用，主要 63192(cagent-tauri) 290MB

## 清理脚本
`/home/ubuntu/bin/zombie-chrome-reaper.sh`（8300B，`bash -n` 通过）

判定规则：
1. 同一 `--user-data-dir` 的 chrome 进程构成"班组"；组内无「ppid 在组外且存活」的父进程
   （即整组被 init 收养）且最老进程超 `GRACE_SEC`(默认 900s) → TERM→KILL
2. `/tmp` 下 `puppeteer_dev_chrome_profile-*` / `playwright_chromiumdev_profile-*`
   超过 `PROFILE_TTL_HOUR`(默认 6h) 未被访问且无存活进程引用 → 删除

关键实现要点（踩过的坑）：
- 进程枚举必须遍历 `/proc/[0-9]*` + `readlink exe` 白名单（chrome/chrome-headless-shell/
  chromium/chromium-browser/headless_shell）。用 `pgrep -f 'chrome|chromium'` 会误匹配 earlyoom
  的参数 `--prefer (chrome|chromium)`
- `get_udir` 不能用 `sed -n 's/^--user-data-dir=//p'`：chrome 的 zygote/renderer 用 prctl 改写 argv，
  整串参数挤在同一字段里，按行匹配会返回空。改用
  `grep -o -- '--user-data-dir=[^[:space:]]*' | head -1 | sed 's/^--user-data-dir=//'`
- 保护名单 `/home/ubuntu/bin/zombie-chrome-reaper.protect` 支持两种写法：裸正则匹配目录、
  `cgroup:正则` 匹配 `/proc/PID/cgroup`。bridge 用后者（目录名随机后缀不可靠）
- `flock -n 9 /tmp/.zombie-chrome-reaper.lock` 防 cron 与手工执行重叠
- 环境变量：`DRY_RUN=1`、`DEBUG=1`、`GRACE_SEC`、`PROFILE_TTL_HOUR`

## crontab
```
*/15 * * * * /home/ubuntu/bin/zombie-chrome-reaper.sh >/dev/null 2>&1
```
备份：`/tmp/crontab.bak.<时间戳>`

## 验证记录
- `GRACE_SEC=0 DRY_RUN=1` 正确识别 ORPHANTEST 班组（9 进程 892MB）
- `SKIP(live-root)` 正确豁免 cagent-shot-*、有活父进程的班组
- `SKIP(cgroup)` 正确豁免 lATIQH（deepseek-web-bridge）
- `SKIP(young Ns)` 正确延迟新起的班组
- TTL 删除实测命中并记录 `[PROFILE] removed`
- `env -i` 模拟 cron 精简环境执行 exit=0

## 遗留
- `deepseek-web-bridge.service` 的 `memory.max=1.9GB` 是否收紧（如 1.5G）未定，需与用户确认；
  收紧可避免整机 OOM，但会让 bridge 自己的 Chrome 被杀（当前 memory.peak 946MB，尚有余量）
- `/tmp/uitest`（53MB）、`/tmp/cdp-profile-m2`（38MB）非 reaper 管理范围，未处理
- `vm.swappiness=30`
