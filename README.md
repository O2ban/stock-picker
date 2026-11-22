# Stock Picker

A small, auditable stock-screening workspace for daily and weekly price-volume strategies.

## What works in v0.1

- Server-side screening over the existing `kline-trainer` SQLite database.
- Daily to weekly OHLCV aggregation.
- A restricted JSON strategy DSL with validation.
- Price and volume indicators: MA, volume MA, volume ratio, momentum, trend strength and moving-average cross.
- Saved strategy versions and screening run records.
- A focused browser workspace for validating a strategy and running a screen.
- No arbitrary JavaScript, Python or SQL execution.

## Run

```bash
npm install
cp .env.example .env
npm start
```

Open <http://localhost:3100>.

The default database path is the existing project database at `../kline-trainer/kline-server/data/kline.db`. Set `KLINE_DB` to override it. The app also starts with an empty demo dataset if the database is unavailable.

## Strategy shape

```json
{
  "version": 1,
  "universe": { "excludeSt": true },
  "all": [
    { "period": "week", "indicator": "close_above_ma", "params": { "length": 20 } },
    { "period": "day", "indicator": "volume_ratio", "params": { "length": 20, "min": 1.5 } }
  ],
  "limit": 100
}
```

## Data source note

The current upstream data source is intended for research validation. Confirm data licensing before any commercial deployment.
