/* 지표 — COIN BOARD tools/scan.py 를 JS로 포팅.
 *
 * 배열은 전부 "오래된 것 → 최신" 순서를 가정한다.
 * 200봉 × 150종목이면 전량 재계산해도 1ms 수준이라 증분 상태를 두지 않는다.
 * 상태를 두면 봉 마감/재연결 시 정합성이 깨지는 쪽이 훨씬 비싸다.
 */
(function (global) {
  'use strict';

  function ema(values, period) {
    if (values.length < period) return null;
    var k = 2 / (period + 1);
    var e = 0;
    for (var i = 0; i < period; i++) e += values[i];
    e /= period;
    for (var j = period; j < values.length; j++) e = values[j] * k + e * (1 - k);
    return e;
  }

  /* Wilder RSI. */
  function rsi(closes, period) {
    period = period || 14;
    if (closes.length < period + 1) return null;
    var gains = [], losses = [];
    for (var i = 1; i < closes.length; i++) {
      var d = closes[i] - closes[i - 1];
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    var ag = 0, al = 0;
    for (var p = 0; p < period; p++) { ag += gains[p]; al += losses[p]; }
    ag /= period; al /= period;
    for (var q = period; q < gains.length; q++) {
      ag = (ag * (period - 1) + gains[q]) / period;
      al = (al * (period - 1) + losses[q]) / period;
    }
    if (al === 0) return ag > 0 ? 100 : 50;
    return 100 - 100 / (1 + ag / al);
  }

  /* ATR을 종가 대비 %로. 변동성 대비 수익 효율 계산에 쓴다. */
  function atrPct(highs, lows, closes, period) {
    period = period || 14;
    if (closes.length < period + 1) return null;
    var trs = [];
    for (var i = 1; i < closes.length; i++) {
      var tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
    var a = 0;
    for (var p = 0; p < period; p++) a += trs[p];
    a /= period;
    for (var q = period; q < trs.length; q++) a = (a * (period - 1) + trs[q]) / period;
    var last = closes[closes.length - 1];
    return last ? (a / last) * 100 : null;
  }

  function pctReturn(closes, barsBack) {
    if (closes.length <= barsBack) return null;
    var past = closes[closes.length - 1 - barsBack];
    if (!past) return null;
    return (closes[closes.length - 1] / past - 1) * 100;
  }

  /* 횡단면 백분위(0~1). null은 중앙값(0.5) 취급.
   *
   * 임의의 상수 임계값 대신 그 시점 시장 분포 안에서 상대평가한다.
   * 시장 전체가 오른 날 모든 종목이 만점을 받는 왜곡을 막는다.
   * 선물은 알트가 한 방향으로 같이 움직이는 성질이 강해 이 보정이 특히 중요하다. */
  function pctRank(values) {
    var out = new Array(values.length);
    var idx = [];
    for (var i = 0; i < values.length; i++) {
      out[i] = 0.5;
      var v = values[i];
      if (v != null && !isNaN(v) && isFinite(v)) idx.push(i);
    }
    if (idx.length < 2) return out;

    idx.sort(function (a, b) { return values[a] - values[b]; });
    var n = idx.length;
    var k = 0;
    while (k < n) {
      var j = k;
      while (j + 1 < n && values[idx[j + 1]] === values[idx[k]]) j++;
      var avgRank = (k + j) / 2;          // 동점은 평균 순위를 공유
      for (var m = k; m <= j; m++) out[idx[m]] = avgRank / (n - 1);
      k = j + 1;
    }
    return out;
  }

  /* RSI를 '건강한 상승'일수록 높은 0~1 점수로 변환.
   *
   * 60 부근이 최적. 과매수(>80)는 추격 구간이라 급격히 감점하고,
   * 과매도(<35)는 하락 추세라 감점한다.
   * '이미 터진 것'이 아니라 '터지는 중'을 잡아야 한다. */
  function rsiQuality(r) {
    if (r == null) return null;
    if (r <= 35) return Math.max(0, ((r - 20) / 15) * 0.3);
    if (r <= 60) return 0.3 + ((r - 35) / 25) * 0.7;
    if (r <= 72) return 1.0 - ((r - 60) / 12) * 0.25;
    if (r <= 85) return 0.75 - ((r - 72) / 13) * 0.65;
    return Math.max(0, 0.10 - ((r - 85) / 15) * 0.10);
  }

  /* 롱 관점의 RSI 품질을 그대로 뒤집은 숏 버전.
   * 선물은 양방향이라 하나의 곡선만 쓰면 숏 후보가 구조적으로 저평가된다. */
  function rsiQualityShort(r) {
    return r == null ? null : rsiQuality(100 - r);
  }

  function mean(a) {
    if (!a.length) return null;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function stdev(a) {
    if (a.length < 2) return null;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }

  global.Ind = {
    ema: ema,
    rsi: rsi,
    atrPct: atrPct,
    pctReturn: pctReturn,
    pctRank: pctRank,
    rsiQuality: rsiQuality,
    rsiQualityShort: rsiQualityShort,
    mean: mean,
    stdev: stdev,
  };
})(window);
