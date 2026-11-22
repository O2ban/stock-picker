---
id: memory-655
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 错误教训
keywords: [manifest路径, 子路径, 404, 添加到主屏幕]
summary: 清单/选股前端页内引用的 manifest 路径是 /stock-picker/manifest.webmanifest，但服务若直接开在根路径则该文件取不到而 404，只影响「添加到主屏幕」体验。
---
子Agent验证时发现：页面里挂的「安装到桌面」配置文件路径是 /stock-picker/manifest.webmanifest，而当前服务直接开在根路径，文件取不到报 404。不影响功能，只影响手机上「添加到主屏幕」的图标体验。与已有记忆 memory-014 的「子路径下绝对路径正确」不矛盾——取决于部署是否真在子路径下。
