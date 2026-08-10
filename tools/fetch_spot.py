#!/usr/bin/env python3
"""현물 5분봉 덤프를 받는다 — 현물-선물 베이시스 거래 검증용.

선물만으로 하는 '펀딩 캐리'는 실패했다. 펀딩 상위를 숏하고 다른 종목을 롱하는
방식은 헤지가 아니라 다른 코인의 가격 위험을 새로 떠안는 것이었고, 실제로
가격손익이 펀딩수취를 거의 정확히 상쇄했다(3일 기준 -1.432% vs +1.392%).

진짜 베이시스 거래는 **같은 심볼의 현물 롱 + 선물 숏**이다. 같은 자산이라
가격 위험이 지워지고 펀딩만 남는다. 그러려면 현물 가격이 필요하다.

선물 유니버스 전부가 현물에 있지는 않다(표본 30종목 중 20종목). 없는 것은 건너뛴다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_history import http, unzip_csv          # noqa: E402  (덤프 처리 로직 재사용)

SPOT = "https://data.binance.vision/data/spot"


def fetch_spot(sym: str, days: list[date], interval: str) -> dict | None:
    klines: list[list] = []
    for d in days:
        blob = http(f"{SPOT}/daily/klines/{sym}/{interval}/{sym}-{interval}-{d}.zip")
        if not blob:
            continue
        for r in unzip_csv(blob):
            # 현물 덤프는 마이크로초 타임스탬프인 날이 섞여 있다. 밀리초로 정규화한다.
            t0 = int(float(r[0]))
            if t0 > 1e14:
                t0 //= 1000
            klines.append([t0, r[1], r[2], r[3], r[4], r[5]])
    if len(klines) < 300:
        return None
    klines.sort(key=lambda x: x[0])
    return {"symbol": sym, "klines": klines}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--interval", default="5m")
    ap.add_argument("--symbols-file", default="docs/data/universe.txt")
    ap.add_argument("--out", default=".cache_spot")
    ap.add_argument("--end", default=None)
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    if args.end:
        y, m, d = (int(x) for x in args.end.split("-"))
        end = date(y, m, d)
    else:
        end = date.today() - timedelta(days=1)
    days = [end - timedelta(days=i) for i in range(args.days)][::-1]

    with open(args.symbols_file) as fp:
        syms = [ln.strip() for ln in fp if ln.strip() and not ln.startswith("#")]
    print(f"대상 {len(syms)}종목 · {days[0]} ~ {days[-1]}", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    done = [0]
    t0 = time.time()

    def work(sym: str):
        path = os.path.join(args.out, f"{sym}.json")
        if os.path.exists(path):
            done[0] += 1
            return sym, True
        data = fetch_spot(sym, days, args.interval)
        if data:
            with open(path, "w") as fp:
                json.dump(data, fp, separators=(",", ":"))
        done[0] += 1
        if done[0] % 20 == 0:
            print(f"  {done[0]}/{len(syms)} ({time.time()-t0:.0f}s)", file=sys.stderr)
        return sym, bool(data)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        res = list(ex.map(work, syms))

    ok = [s for s, good in res if good]
    print(f"현물 확보 {len(ok)}/{len(syms)}종목 ({time.time()-t0:.0f}s) → {args.out}/", file=sys.stderr)
    print(f"(현물 미상장 {len(syms)-len(ok)}종목은 베이시스 거래 대상에서 제외)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
