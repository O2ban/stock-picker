#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 min5/*.json（10MB 二维数组）转成后端可按天切片读取的紧凑格式。

为什么要转：
  1. 原 JSON 单文件 10MB，后端每次请求都 JSON.parse 一次不可接受；
  2. 图表只需要「最近 N 个交易日」的 5 分钟 K 线，用不上全量 8 万根。

产出（目录 data/min5/）：
  <code>.ndjson   每行一根：YYYYMMDDHHMM,o,h,l,c,vol,amount
  <code>.idx      每行一天：YYYYMMDD,<该日首行字节偏移>,<该日根数>

后端读 .idx 定位到第 K 天，再从 .ndjson 的字节偏移往后流式读若干行即可。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'min5')
DST = os.path.abspath(os.path.join(ROOT, '..', '..', 'data', 'min5'))


def main():
    os.makedirs(DST, exist_ok=True)
    files = sorted(f for f in os.listdir(SRC) if f.endswith('.json'))
    if not files:
        print('no source json', file=sys.stderr)
        return 1

    for fn in files:
        src_path = os.path.join(SRC, fn)
        key = fn[:-5].replace('_', '')          # sh_600519 -> sh600519
        out_nd = os.path.join(DST, key + '.ndjson')
        out_ix = os.path.join(DST, key + '.idx')

        with open(src_path, 'r', encoding='utf-8') as fh:
            rows = json.load(fh)

        offset = 0
        idx_lines = []
        cur_day = None
        day_start = 0
        day_count = 0
        total = 0

        with open(out_nd, 'w', encoding='utf-8', newline='\n') as out:
            for r in rows:
                # [日期, 时间戳(YYYYMMDDHHmmssSSS), 开, 高, 低, 收, 成交量, 成交额]
                day = str(r[0])
                ts = str(r[1])
                stamp = ts[:12]                  # YYYYMMDDHHmm
                line = '%s,%s,%s,%s,%s,%s,%s\n' % (
                    stamp, r[2], r[3], r[4], r[5], r[6], r[7]
                )
                if day != cur_day:
                    if cur_day is not None:
                        idx_lines.append('%s,%d,%d' % (cur_day, day_start, day_count))
                    cur_day = day
                    day_start = offset
                    day_count = 0
                out.write(line)
                n = len(line.encode('utf-8'))
                offset += n
                day_count += 1
                total += 1
            if cur_day is not None:
                idx_lines.append('%s,%d,%d' % (cur_day, day_start, day_count))

        with open(out_ix, 'w', encoding='utf-8', newline='\n') as out:
            out.write('\n'.join(idx_lines))
            out.write('\n')

        print('%s -> %s  bars=%d days=%d size=%dKB' % (
            fn, key, total, len(idx_lines), os.path.getsize(out_nd) // 1024
        ))

    print('dst', DST)
    return 0


if __name__ == '__main__':
    sys.exit(main())
