---
id: memory-641
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 方法经验
keywords: [虚拟滚动, 清单页, renderPicks, V_LIST_MIN, drawSparks]
summary: 列表页渲染数千行（每行含 canvas）会必然卡顿，需复用选股页已有的虚拟渲染方案（V_LIST_MIN=150 占位渲染）并按需补 K 线。
---
H3 缺陷：清单页 renderPicks 一次性 innerHTML 全量 rowLi（每行含 <canvas>），随后 drawSparks(true) 重画全部迷你K线、loadKlines 以60只/批发上百批请求。选股页为此专门做了 V_LIST_MIN=150 的虚拟渲染，清单页没有。修法：清单页复用 vRender 的占位方案，上下放空白撑高，K线按需补。实测158只票页面总高约1.1万像素但只渲染22行左右，滚动稳定。
