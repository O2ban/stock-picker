---
id: memory-597
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-25T22:33:46+08:00
updated: 2026-10-25T22:33:46+08:00
importance: medium
category: 方法经验
keywords: [deepseek-web-bridge, 内存占用, 无效调用, 低内存清理, 服务停用, 临时目录, 境外调用]
summary: 长期不用的网页版 DeepSeek 转接口服务会常驻内存（约320MB）且可能持续被外部无效调用，低内存机器上应及时停用并清理调试残留目录。
---
该服务平时为子代理提供网页版 DeepSeek 查询能力，但 agent 未使用时仍可能被外部（含境外地址）持续调用，且调用全部失败返回。它开着的浏览器实例约占320MB内存，在3.7G内存的机器上属于可释放的占用。长期挂起但无有效产出的服务应停掉以释放内存，待需要时再启动。此外 /tmp 下十六个调试残留的临时浏览器目录（160多兆）属纯垃圾，可随时清理。
