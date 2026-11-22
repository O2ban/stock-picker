import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePeriod, runScreen, validateStrategy } from './src/engine.js';

const rows = Array.from({ length: 30 }, (_, index) => ({ date: `2025-01-${String(index + 1).padStart(2, '0')}`, o: index + 1, h: index + 2, l: index, c: index + 1.5, vol: 100 + index, amount: 1000 }));

test('aggregates daily rows into weekly rows', () => assert.ok(aggregatePeriod(rows, 'week').length >= 4));
test('rejects unsupported indicators', () => assert.throws(() => validateStrategy({ version: 1, all: [{ period: 'day', indicator: 'shell', params: {} }] })));
test('screens a stock with daily and weekly conditions', () => {
  const strategy = { version: 1, all: [{ period: 'week', indicator: 'close_above_ma', params: { length: 2 } }, { period: 'day', indicator: 'volume_ratio', params: { length: 2, min: 0.5 } }], limit: 10 };
  const result = runScreen(strategy, [{ code: 'x', name: 'X', board: 'demo' }], () => rows);
  assert.equal(result.count, 1);
  assert.equal(result.results[0].code, 'x');
});

// 受限表达式条件：白名单字段 + 窗口函数，在整段历史上滚动求值（不执行任意脚本）。
test('evaluates whitelisted expr conditions over the row window', () => {
  const strategy = {
    version: 1,
    vars: { hi: { op: 'hhv', n: 5, args: [{ op: 'field', name: 'close' }] } },
    all: [
      { period: 'day', indicator: 'expr', params: { expr: { op: '>=', args: [{ op: 'field', name: 'close' }, { op: 'var', var: 'hi' }] } } },
      { period: 'day', indicator: 'expr', params: { expr: { op: 'count', n: 5, args: [{ op: '>', args: [{ op: 'field', name: 'close' }, 0] }] } } },
    ],
    limit: 10,
  };
  const result = runScreen(strategy, [{ code: 'x', name: 'X', board: 'demo' }], () => ({ daily: rows }));
  assert.equal(result.count, 1);
  assert.equal(result.results[0].code, 'x');
});

test('rejects expr with a non-whitelisted field or function', () => {
  assert.throws(() => validateStrategy({ version: 1, all: [{ period: 'day', indicator: 'expr', params: { expr: { op: 'field', name: 'pe' } } }] }));
  assert.throws(() => validateStrategy({ version: 1, all: [{ period: 'day', indicator: 'expr', params: { expr: { op: 'exec', args: [{ op: 'field', name: 'close' }] } } }] }));
});
