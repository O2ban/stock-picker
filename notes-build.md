# Build Notes

## 2026-09-21

- Created an independent GitHub-ready project in `/home/ubuntu/stock-picker`.
- First implementation target: server-side daily/weekly screening with restricted DSL and a usable browser workspace.
- Existing database compatibility: `stocks` and `daily_kline`, with `raw/qfq/hfq` price columns and `vol/amount`.
- AI natural-language parsing remains an adapter boundary; the MVP must run without an external model.
