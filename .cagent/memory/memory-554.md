---
id: memory-554
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T17:37:01+08:00
updated: 2026-10-20T17:37:01+08:00
importance: low
category: 用户习惯与关切
keywords: [iphone-safe-area, bottom-padding, home-indicator, touch-target]
summary: stock-picker 移动端底部安全区在系统 Home 横线高度基础上再统一多留 8 像素，底部导航栏、全屏下钻页、看盘抽屉三处一致，避免贴横线导致误触。
---
原实现只按 iOS 系统安全区高度留白，实测正好贴着 Home 横线、容易误触。现改为在系统安全区基础上额外加 8 像素，并在三处统一：底部导航栏、左滑全屏下钻页、看盘抽屉，实测抽屉底部到屏幕底留出 8 像素空档。属该项目的 UI 约束偏好。
