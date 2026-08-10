#!/usr/bin/env python3
"""data.binance.vision 공개 덤프를 내려받아 리플레이용 캐시를 만든다.

fapi는 GitHub Actions(미국 IP)에서 451로 막힐 수 있지만 이 덤프 호스트는 막히지 않는다.
그래서 백테스트 계열 작업은 전부 이쪽을 쓴다.

받는 것 (전부 5분 단위로 정렬 가능)
  klines   : 가격/거래대금
  metrics  : sum_open_interest — 라이브의 OI 팩터를 그대로 재현하는 데 필요
  funding  : 8시간 정산 펀딩비 (월 단위 파일)

표준 라이브러리만 쓴다.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

VISION = "https://data.binance.vision/data/futures/um"
FAPI = "https://fapi.binance.com"


def http(url: str, retries: int = 3) -> bytes | None:
    delay = 0.5
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None          # 그날 덤프가 없는 종목 — 정상 상황
            if attempt == retries - 1:
                return None
        except Exception:
            if attempt == retries - 1:
                return None
        time.sleep(delay)
        delay *= 2
    return None


def unzip_csv(blob: bytes) -> list[list[str]]:
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = z.namelist()[0]
        text = z.read(name).decode("utf-8", "replace")
    rows = list(csv.reader(io.StringIO(text)))
    # 덤프에 헤더가 있는 날과 없는 날이 섞여 있다. 첫 칸이 숫자가 아니면 헤더로 본다.
    if rows and rows[0] and not rows[0][0].replace(".", "").isdigit():
        rows = rows[1:]
    return rows


def top_symbols(n: int) -> list[str]:
    """현재 거래대금 상위 N개.

    주의: 이 선정 자체가 '오늘 유동한 종목'을 고르는 것이라 생존 편향이 있다.
    리플레이 결과에 그대로 명시한다(track.json.caveats).
    """
    raw = json.loads(http(f"{FAPI}/fapi/v1/exchangeInfo"))
    perp = {
        s["symbol"]
        for s in raw["symbols"]
        if s["status"] == "TRADING" and s["contractType"] == "PERPETUAL" and s["quoteAsset"] == "USDT"
    }
    ticks = json.loads(http(f"{FAPI}/fapi/v1/ticker/24hr"))
    cand = [(float(t["quoteVolume"]), t["symbol"]) for t in ticks if t["symbol"] in perp]
    cand.sort(reverse=True)
    return [s for _, s in cand[:n]]


def fetch_funding(sym: str, start_ms: int) -> list[list]:
    """펀딩비 이력.

    덤프의 fundingRate는 '월간' 파일뿐이라 그 달이 끝나야 올라온다. 최근 구간을
    리플레이하려면 항상 비어 있으므로 fapi REST에서 받는다(weight 1, 지역 차단 시 빈 값).
    """
    url = f"{FAPI}/fapi/v1/fundingRate?symbol={sym}&startTime={start_ms}&limit=1000"
    blob = http(url)
    if not blob:
        return []
    try:
        return sorted([[int(r["fundingTime"]), float(r["fundingRate"])]
                       for r in json.loads(blob)])
    except Exception:
        return []


def fetch_symbol(sym: str, days: list[date], months: list[str], interval: str) -> dict | None:
    klines: list[list] = []
    for d in days:
        blob = http(f"{VISION}/daily/klines/{sym}/{interval}/{sym}-{interval}-{d}.zip")
        if not blob:
            continue
        for r in unzip_csv(blob):
            # [openTime, o, h, l, c, v, closeTime, quoteVol, trades, ...]
            klines.append([int(float(r[0])), r[1], r[2], r[3], r[4], r[5],
                           int(float(r[6])), r[7], int(float(r[8]))])

    if len(klines) < 300:
        return None

    oi: list[list] = []
    for d in days:
        blob = http(f"{VISION}/daily/metrics/{sym}/{sym}-metrics-{d}.zip")
        if not blob:
            continue
        for r in unzip_csv(blob):
            # create_time, symbol, sum_open_interest, ...
            try:
                ts = int(time.mktime(time.strptime(r[0], "%Y-%m-%d %H:%M:%S"))) * 1000
                ts -= time.timezone * 1000          # 덤프는 UTC 기준
                oi.append([ts, float(r[2])])
            except Exception:
                continue

    funding = fetch_funding(sym, klines[0][0])

    klines.sort(key=lambda x: x[0])
    oi.sort(key=lambda x: x[0])
    funding.sort(key=lambda x: x[0])
    return {"symbol": sym, "klines": klines, "oi": oi, "funding": funding}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=10)
    ap.add_argument("--symbols", type=int, default=120)
    ap.add_argument("--interval", default="5m")
    ap.add_argument("--out", default=".cache")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    # 오늘 덤프는 아직 안 올라온다. 어제까지를 끝으로 본다.
    end = date.today() - timedelta(days=1)
    days = [end - timedelta(days=i) for i in range(args.days)][::-1]
    months = sorted({f"{d.year}-{d.month:02d}" for d in days})
    print(f"기간 {days[0]} ~ {days[-1]} ({len(days)}일), 월 파일 {months}", file=sys.stderr)

    syms = top_symbols(args.symbols)
    print(f"대상 {len(syms)}종목", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    done = [0]
    t0 = time.time()

    def work(sym: str):
        path = os.path.join(args.out, f"{sym}.json")
        if os.path.exists(path):                      # 이미 받은 건 건너뛴다
            done[0] += 1
            return sym, True
        data = fetch_symbol(sym, days, months, args.interval)
        if data:
            with open(path, "w") as fp:
                json.dump(data, fp, separators=(",", ":"))
        done[0] += 1
        if done[0] % 10 == 0:
            print(f"  {done[0]}/{len(syms)} ({time.time()-t0:.0f}s)", file=sys.stderr)
        return sym, bool(data)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        results = list(ex.map(work, syms))

    ok = [s for s, good in results if good]
    print(f"완료 {len(ok)}/{len(syms)}종목 ({time.time()-t0:.0f}s) → {args.out}/", file=sys.stderr)

    with open(os.path.join(args.out, "_manifest.json"), "w") as fp:
        json.dump({"symbols": ok, "days": [str(d) for d in days],
                   "interval": args.interval}, fp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
