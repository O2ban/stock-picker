# 项目记忆索引

> 这是记忆目录，不是记忆正文。
> 每条记忆的完整内容存放在 `/home/ubuntu/stock-picker/.cagent/memory` 目录下的 `memory-NNN.md` 文件中，索引条目前的编号就是文件名。
> 判断"有没有相关经验"看索引即可；需要完整做法、原因或边界时，用 read_file 读取对应编号的文件。
> 条目格式：`memory-NNN · 摘要（关键词）`；分组按知识类别，类别内按重要程度分层。

## 其他

### 高

- memory-066 · stock-picker「两查合一」改动已实施上线：同一窗口数据被 daily_indicators 和 daily_kline 各读一遍合并为单次查询，热缓存 loadMs 2.5s→1.3s、冷缓存 24.7s→14.3s，选股结果与改前完全一致（停牌/除权股逐行核对无差异）。（loadMs、统计口径、冷读盘、engineMs、elapsedMs-loadMs、页缓存、性能归因、stock-picker、两查合一、daily_indicators、daily_kline）
- memory-025 · stock-picker 取数层发现同一窗口 437364 行被 daily_indicators 和 daily_kline 完整读了两遍，两表 close/vol 完全一致（停牌填充在入库阶段已写进 kline），纯 expr 策略可合并为单次查询，冷盘 21.3s→11.0s、热盘 1.78x。（两次查询合并、停牌填充、daily_indicators、daily_kline、两表等价、随机IO减半、stock-picker、纯expr策略）
- memory-064 · stock-picker 线上 25.7s 异常不是引擎慢，而是统计口径记错（elapsedMs - loadMs 才是 engine，实测仅 1.3~1.5s）+ 数据库冷读盘（清空 OS 页缓存后 loadMs 24.7s），冷读盘比任何 JS 层优化重要两个数量级。（loadMs、统计口径、engineMs、elapsedMs-loadMs、冷读盘、页缓存、性能归因、stock-picker）
- memory-058 · stock-picker 预计算指标口径实测确认：MA 是含当日的（实时 bar 的 MA 必须含自身才与库内一致），VR 分母是不含当日的；审查提出的「MA 把实时 bar 算进去」是误报。（stock-picker、MA口径、VR口径、实时bar、含当日、排除当日、库内数据验证、审查误报）
- memory-055 · stock-picker 的行情自动刷新机制：前端 60 秒定时器汇总当前需要看价的股票（看盘中优先、自选、选股结果，最多 100 只）批量拉 /api/quotes，后端直连腾讯 qt.gtimg.cn（单次最多 60 代码分批并发），带 5 秒内存缓存与 in-flight 去重。（stock-picker、quote-refresh、60s-timer、allCodes、100-codes-cap、tencent-quote、in-flight-dedup、行情刷新机制）
- memory-051 · cagent 所在 3.7G 机器上僵尸 Chrome 的根因是父脚本退出后被 init(1) 收养的 puppeteer/playwright 进程组以及 /tmp 下累积的孤立 profile 目录，已用 zombie-chrome-reaper.sh 每 15 分钟 cron 清理，笔记在 notes/chrome-memory-reaper.md。（zombie-chrome-reaper、crontab、puppeteer-orphan、profile-cleanup、chrome-memory、深挖根因、cron-env-simulation）
- memory-052 · stock-picker 当日选股未接实时价的根因是 REALTIME_PRICE_MAP 环境变量从未被赋值，修复时连带需处理四个缺陷：盘中量比折算、停牌/节假日假 K 线、周线混入盘中量、baseDate 与实时价口径矛盾。（REALTIME_PRICE_MAP、realtime-quote-selection、volume-ratio-intraday、baseDate-consistency、look-ahead-bias、halts-fake-kline、weekly-rt-bar-exclusion）
- memory-053 · cagent 前端 agent 选择器（Cagent/Codex）通过 applyAgentMode 调 set-mode 写 codex_mode 字段，opencode 因后端无 runner 服务刻意未加入；机器菜单与 agent 菜单同开是 hostMenuRef 挂在外层容器导致 contains() 误判。（codex_mode、agent-selector、applyAgentMode、opencode-missing-runner、hostMenuRef、cagent-chat-panel、menu-ref-containment）
- memory-045 · stock-picker 看盘『最新日K不及时』的根因已定位：前端K线缓存TTL(3天，内存+IndexedDB双层)与 eltdx 数据源收盘后(15:45)落库节奏错位，而非接口慢(/api/kline 实测约0.01s)，修复为看盘主图 load 改 stale-while-revalidate。（stock-picker、最新日k、缓存TTL、eltdx、stale-while-revalidate、数据落库节奏、chart.js、看盘）
- memory-036 · stock-picker 把实时价并入最后一根 K 线时必须加周期守卫：只有日线视图才并入，周线/月线是一周/一月聚合柱，塞入当日实时价会让均线、成交量等指标全算错。（stock-picker、applyQuote、realtime-quote、period-guard、weekly-kline、kline-override、指标污染）
- memory-037 · stock-picker 的 public/ 静态前端文件每次请求实时读盘，前端改动刷新即生效无需重启或构建；服务端 node 代码才需重启，且 restart_service 工具重启的是 cagent 对话进程而非 stock-picker，package.json 里也没有 release 脚本。（stock-picker、static-file-realtime-read、no-build、no-release-script、restart-service-tool、cagent-vs-stock-picker）
- memory-029 · 选股应用的「基准日回看」功能在历史日期命中周期中间时，若把库里那根完整周线/月线（含未来交易日数据）算进均线窗口，会造成前视偏差，等于提前知道了未来几天的走势，回看结果不可信。（stock-picker、time-filter、look-ahead-bias、baseline-date、incomplete-week、backtest-fidelity、future-data、回看偏差）
- memory-026 · stock-picker性能优化最大单点突破：daily_indicators表加idx_di_date索引并将查询从WHERE code IN(5574个code)改为WHERE date范围查询，DB查询从17秒降到0.01秒。（date-index、daily_indicators、full-table-scan、IN-query、performance、stock-picker、query-rewrite）
- memory-020 · stock-picker 预计算表实际字段名细节：指标字段无下划线（ma5/vr5 而非 ma_5）、周线主键是 week_start 而非 date、daily_kline 无裸 OHLCV 只有 qfq/hfq/raw 三套复权字段，改造 db.js 时必须严格对齐，否则运行时直接抛 no such column。（stock-picker、precompute-schema、field-naming、ma5、week_start、qfq-only、column-mismatch）
- memory-021 · stock-picker 预计算接入引擎采用『换 loadRows 回调』而非改 engine 内部：engine.runScreen 通过 loadRows(code, adjust) 回调拿数据，只需在 server.js 传一个走预计算查表+今日补齐的新回调，engine.js 一行不改，改动面最小。（stock-picker、engine-architecture、loadRows-callback、precompute-integration、minimal-change、callback-injection）
- memory-018 · stock-picker 预计算表最终 schema 与三个必须修的口径细节：daily_indicators 需含 close 字段供实时补齐 MA 用；停牌日 close 用前一日填充对齐通达信而非跳过；volume_ratio 必须覆盖 5/10/20/60 四个长度而非写死 5；复权只跑 qfq 省 66% 存储。（stock-picker、precompute、table-schema、weekly_kline、daily_indicators、suspended-fill、volume_ratio、qfq）
- memory-010 · stock-picker项目的最大功能缺口是AI自然语言转策略尚未实现，用户仍需手写JSON DSL。（stock-picker、AI选股、自然语言转策略、功能缺口）
- memory-001 · kline项目选股应用的核心设计出发点：同时支持日线、周线、月线多周期分析，这是区别于多数仅支持单一周期的炒股应用的差异化需求。（选股设计、多周期分析、日周月联动、stock-picker）
- memory-002 · 选股应用采用AI将自然语言转换为受限策略DSL再执行的方案，保证脚本可审计、可复用、安全可控。（AI选股、策略DSL、脚本审计、选股模式）

### 中

- memory-067 · stock-picker 本轮只读审查的 P2『量比回退分支把当天算进分母』是旧版本遗留的误报，当前代码已是不含当天的写法；其余 4 条 P3 均为改动前既有小毛病，按『没让改的地方不动』原则未处理。（stock-picker、审查误报、P2、量比回退分支、不含当天、旧版本残留、只读审查、范围纪律）
- memory-065 · stock-picker 周线只提速 1.05x 属结构性收益低（周线表行数少、裁掉的 slice/reduce 在总成本占比极小，分母是取数固定开销），不值得为它加 eager 预取用复杂度换不可感知收益。（周线优化、eager预取、收益结构性低、slice-reduce、分母固定开销、stock-picker、投入产出）
- memory-062 · stock-picker 项目的『每分钟最新股价』实为前端打开页面后每分钟请求 /api/quotes 拉一次快照并直连腾讯行情、5秒内存缓存、不落库，与『存储分钟K线数据』是两回事，项目内没有 min1/min5 等分钟级表。（stock-picker、实时行情、分钟K线、/api/quotes、前端轮询、不落库、口径区分、qt.gtimg.cn）
- memory-057 · stock-picker 新增非交易时段（含非交易日）不更新实时行情的守卫，涉及 chart.js 实时合并与 app.js 两处，且 state.quote 必须在开仓时重置，否则换股会把上一只的行情叠加进来。（stock-picker、非交易时段、实时K线、交易时段守卫、state.quote、开仓重置、换股串行情）
- memory-059 · 本轮审查核实后只剩两处真问题：realtime:false 时仍拉行情、engine 量比回退分支分母含当日；其余口径保留。（stock-picker、审查处置、realtime:false、量比回退分支、真问题、保留口径）
- memory-060 · 「IndexedDB 污染」遗留问题的根因是验证脚本访问了会 404 的 /stock-picker/ 子路径导致页面从未加载，改用根路径 127.0.0.1:3100 后证明缓存正常、污染问题可关闭。（cacheclean、IndexedDB污染、验证脚本地址写错、404、127.0.0.1:3100子路径、cacheproof、浅拷贝修复）
- memory-056 · stock-picker「价格是活的、图形是昨天的」不一致属刻意设计（applyQuote 只把实时价并进日线最后一根，K 线走 3 天 TTL 的 IndexedDB 缓存），用户认为该不一致影响看图、已要求修改。（stock-picker、applyQuote、最后一根K线、period-guard、kline-3day-ttl、价格与图形不一致、实时价并图）
- memory-054 · cagent 前端改动验证的可靠做法是用 headless 浏览器实测几何与接口调用（不靠读代码），但测试脚本自身易出错——取错会话 id、选择器取到带勾选项，会导致假失败。（headless-browser-verification、cdp-geometry、test-script-wrong-target、conversation-id-mismatch、frontend-e2e）
- memory-038 · stock-picker 横滑换股走 tdx:switch 路径不会回填行情导致主图无最新价，修复需把换股路径做成与 openChart 一致的两步叠加，并加丢弃检查防止快速横滑串票。（stock-picker、实时价、tdx:switch、switch-stock、applyQuote、cache-override、换股回填、行情叠加）
- memory-047 · stock-picker 列表加涨幅排序时，所有会重建列表的入口（排序切换、分钟行情自动重排）都必须把迷你 K 线重绘和邻票同步放进渲染函数，否则会出现 K 线空白和横滑落到旧顺序。（stock-picker、排序、涨幅排序、orderedList、自动重排、迷你K线重绘、邻票同步、cycleSort、quotes-items）
- memory-048 · stock-picker 排序功能中两个隐患（迷你K线消失、邻票不同步）是子代理只读审查发现的，说明列表重建类改动应收敛到渲染函数而非散落在各触发路径。（stock-picker、子代理审查、自动重排、收尾遗漏、渲染函数重绘、审查价值）
- memory-049 · 用户要求 cagent 的节点/agent 选择器从输入框上方移到输入框下方，且形态须为「图标+当前节点名+下拉箭头」的下拉式而非平铺 chip 组，需以参考截图为准。（cagent、节点选择器、机器选择器、输入框下方、下拉式、参考截图、UI偏好）
- memory-034 · kline 生态的日线数据源是 eltdx_downloader.py(通达信协议)，由 systemd timer kline-daily.timer 每交易日收盘后(约15:45/15:48)触发增量下载，耗时约12分钟，因此盘中数据库内最后一根日K始终是上一交易日。（eltdx、eltdx_downloader.py、通达信协议、kline-daily.timer、systemd-timer、收盘后落库、增量更新、数据源）
- memory-043 · 用户要求股票代码在展示和复制时都不带交易所前缀字母（如 sh/sz），这是 stock-picker 看盘界面的明确 UI 偏好，影响所有代码展示与复制入口。（stock-picker、股票代码显示、交易所前缀、复制行为、UI偏好、sh-sz前缀）
- memory-042 · stock-picker 中当 currentStrategyId 为 'local:current'（用户存过本地草稿）时，保存判断会拒绝把目标切回库里的真实策略，导致界面显示库里策略但保存却写进并覆盖本地草稿。（stock-picker、app.js、local:current、strategy-save-misroute、local-draft-overwrite、short-path-inconsistency、save-target）
- memory-040 · stock-picker 启动序列有两条策略初始化路径会打架：loadStrategyLibrary() 先选中首项并同步设置页，随后 applyHistoryItem(historyItems[0]) 经 syncStrategyBar() 改 select.value 不派发 change，导致选股页与设置页策略不一致。（stock-picker、startup-init、init-path-conflict、syncStrategyBar、applyHistoryItem、loadStrategyLibrary、state-desync）
- memory-041 · stock-picker 策略『改名不新增』应走后端按 id 更新接口：策略 id 即 strategies/*.json 文件名，需写回对应文件并同步内存，前端保存改走后端后不再在本地下拉框新增策略项。（stock-picker、strategy-rename、PUT-strategy-api、id-is-filename、no-new-option、backend-update、validateStrategy）
- memory-014 · stock-picker 前端 API_BASE 通过 location.pathname.startsWith('/stock-picker') 自动识别子路径，index.html 里写死的 /stock-picker/manifest.webmanifest 绝对路径在正式子路径下是正确的，直连 3100 根路径看到的 manifest 404 只是开发调试现象不是缺陷。（stock-picker、API_BASE、sub-path、location.pathname、manifest-404、dev-vs-prod-path、nginx）
- memory-039 · stock-picker 策略栏的 'run:current' 是占位项（库里找不到历史记录策略名时用），选中它会让 change 监听器去请求 /api/strategies/run:current 必然 404，需加显式返回分支拦截。（stock-picker、run:current、placeholder-item、strategy-bar、change-listener、无效请求）
- memory-035 · stock-picker 自选列表的迷你 K 线用 canvas 手绘而非 ECharts，因为列表内挂多个图表实例会拖慢滚动。（stock-picker、mini-kline、canvas-vs-echarts、列表性能、sparkline）
- memory-032 · stock-picker「综合分恒为1」的根因是 engine.js 在策略无 score 数组时回退到用 all 布尔条件打分，布尔筛选每项得分恒为 0/1，权重归一化后恒等于 1，导致该分毫无区分度。（stock-picker、score-fallback、综合分恒为1、engine.js、布尔条件评分、排序无区分度）
- memory-033 · stock-picker 换股体感卡的瓶颈不是 K 线加载（缓存已命中，fetch≈0ms），而是 ECharts setOption 渲染 20-27ms，用双画布预渲染邻票+跟手滑入解决。（stock-picker、换股性能、setOption渲染瓶颈、缓存、双画布预渲染、跟手滑入、TdxChart、prefetch、测速误判）
- memory-030 · stock-picker 时间筛选只在主分支生效，切到'后复权/未复权'时后端分支绕过了日期裁剪走全量取数再现场聚合，界面显示'三个月前'但结果是'截至最新'，是最危险的假生效形态。（stock-picker、time-filter、partial-branch、silent-failure、adjust-mode、hfq-raw、filter-bypass、stock-picker、假生效）
- memory-027 · stock-picker取数天数应从策略最长参数自动推导(calcNeedDays)，与前端扫描窗口天数(scanWindowDays)解耦——之前取max导致取90天而非策略实际需要的25天。（calcNeedDays、scanWindowDays、strategy-param、data-fetch、decoupling、over-fetching、stock-picker）
- memory-028 · stock-picker当前周周线实时拼合方案：从日线数据提取本周交易日聚合收盘/成交量，从历史完整周线推导本周均线/量比，追加到weeklyMap末尾，消除通达信含当前周而预计算只存完整周的选股偏差。（weekly-splice、current-week、daily-to-weekly、realtime、stock-picker、precompute-gap、tdx-consistency）
- memory-022 · stock-picker 预计算落地的具体配置决策：均线/量比只存 5/10/20/60 四档够用不再扩，扫描窗口按用户设定 3 个月并额外加 60 天缓冲区用于 MA60 计算（窗口外不入库只用于计算参考），此组合已定不再讨论。（stock-picker、precompute-config、indicator-tiers、scan-window、ma60-buffer、4-tiers）
- memory-023 · stock-picker 预计算表的量比口径与通达信存在细微差异需慎重：库里的 vr 分母是'前 N 天均量（不含当天）'，通达信用的是'含当天的 N 天均量'，两者会导致量比筛选结果在临界值（如 1.2）附近翻转；且库里只存了量比结果未存均量分母，展示详情时无法还原原始均量值。（stock-picker、volume-ratio-caliber、tdx-difference、volume-averaging、denominator-inclusion、subtle-bug）
- memory-024 · stock-picker 预计算表周线最新一根日期落后日线数天，因为不完整周未入库；而通达信包含进行中的当前周数据——这会导致'周线站上均线'判断偏保守，可能漏选部分实际符合条件的票，是隐藏在指标口径下的选股偏差。（stock-picker、weekly-half-week、tdx-vs-precompute、judge-conservative、incomplete-period、hidden-bias）
- memory-019 · stock-picker 数据库策略：必须复用 kline-trainer 的 kline.db 绝不单独建 indicators.db，复权只处理前复权（qfq）。（stock-picker、kline-db-reuse、database-decision、qfq-only、no-separate-db）
- memory-015 · stock-picker 选股引擎慢的根因是同一只股票在条件判断/评分/结果生成阶段被重复加载 2-5 次全历史日线（N+1 模式），叠加 Node 同步串行执行阻塞事件循环，5574 只股票累计上万次查询会触发浏览器请求超时。（stock-picker、performance、n+1-query、synchronous-blocking、kline-repeat-load、event-loop、browser-timeout）
- memory-017 · stock-picker 前端出现 Failed to fetch 或响应体被误当作 HTML 解析，通常不是网络故障，而是后端计算耗时过长导致 Nginx 或上游超时后返回 HTML 错误页，需区分网络层故障与上游超时。（stock-picker、failed-to-fetch、html-misparse、timeout、error-signature、frontend-debugging）
- memory-016 · stock-picker 需新增界面可配置的选股范围功能，核心原则是把范围缩小放在扫描入口（后端只拿需要的股票进入计算），而非计算完成后再过滤；用户认为没必要全市场逐只扫描，可配置化能极大提速。（选股范围配置、UI可配置、前置过滤、扫描入口、stock-picker、early-narrowing）
- memory-007 · stock-picker 应复用 kline-trainer 已安装的 better-sqlite3 模块直接读取其 kline.db，不重新 npm install、不复制数据库、不下载行情，数据库路径由 KLINE_DB 环境变量配置。（kline.db、better-sqlite3、数据库直连、KLINE_DB、依赖复用、node_modules）
- memory-011 · stock-picker的策略保存和运行记录当前仅存在Node.js内存Map中，服务重启后全部丢失，尚未实现SQLite持久化。（stock-picker、策略持久化、内存存储、数据丢失）
- memory-012 · stock-picker项目的README存在与实际代码不同步的问题：仍描述演示数据兜底但代码已改为单一路径直连kline.db。（stock-picker、README不一致、文档同步、项目状态）
- memory-008 · 减少功能复杂度时应移除所有降级兼容路径，保持单一路径实现以避免维护负担。（minimal-implementation、single-path、fallback-removal、code-simplification）
- memory-004 · stock-picker 项目采用AI解析作为可替换适配层的设计，避免核心选股链路绑死在某个模型服务上，核心执行链通过DSL实现。（stock-picker、架构设计、AI解耦、适配层、项目边界）
- memory-005 · stock-picker 的数据适配层同时支持真实 kline.db 和内置演示数据，确保GitHub新用户无需准备行情库即可运行。（数据适配层、演示数据、SQLite、kline.db、零依赖启动）
- memory-003 · 选股需要的量价指标（价格均线、量能均线等）通过服务端程序自动计算写入数据库，前端不重复计算。（量价指标、预计算、数据库字段、kline-schema）

### 低

- memory-063 · stock-picker 行情刷新的定时轮询受 inTradingWindow()（9:15-11:30 / 13:00-15:05）守卫只交易时段运行，但 refreshQuotes() 在 8 处交互点（切tab/换股/加自选/页面可见/focus 等）直接调用不受时段限制，这是刻意设计——收盘后用户主动打开页面应看到当天收盘价而非旧缓存。（stock-picker、交易时段守卫、inTradingWindow、setTimeout轮询、refreshQuotes、交互触发刷新、非交易时段空转）
- memory-061 · verify_final 报告的 mismatch（sh601339 7.69 vs 7.68 等）是盘中两次快照间价格跳了一分钱造成的噪声，不是口径错误，无需追查。（verify_final、mismatch、盘中价格跳动、快照噪声、区间复核、不必追）
- memory-050 · stock-picker 排序后打开列表末尾的股票时横滑不动是正常行为（没有下一只），不属于 bug。（stock-picker、横滑边界、最后一只、无法滑动、非bug）
- memory-046 · stock-picker 后端 applyRealtimeToDaily 依赖的 REALTIME_PRICE_MAP 从未被任何代码填充，该『盘中实时补齐』函数实为 no-op，排查盘中K线补齐问题时应知道这条后端路径是死的。（applyRealtimeToDaily、REALTIME_PRICE_MAP、no-op、死代码、stock-picker、盘中补齐、kline）
- memory-044 · 用户要求在 stock-picker 看盘界面顶部新增「加自选」按钮，使用图标形式，放置在「复制代码」按钮左侧。（stock-picker、加自选按钮、图标按钮、按钮布局、看盘界面、UI偏好）
- memory-031 · stock-picker 前端请求体发 dsl、后端读 strategy，字段名不一致导致用户改的策略根本没传进后端，一直用的是内置 starter（碰巧和默认示例一样所以长期未暴露）。（stock-picker、parameter-mismatch、dsl-vs-strategy、frontend-backend、silent-misconfiguration、stock-picker）
- memory-013 · stock-picker项目中月线仅代码预留，实际遇到会报错，当前真实支持的周期只有日线和周线。（stock-picker、月线预留、period支持、功能边界）
- memory-009 · better-sqlite3等原生模块缺少index.js时是依赖安装不完整问题，非代码逻辑错误，需重新npm install修复。（better-sqlite3、native-module、installation、debugging、dependency）
- memory-006 · stock-picker 中 better-sqlite3 原生模块安装可能超时，需在构建说明中记录处理方案。（better-sqlite3、原生依赖、安装超时、npm install）

