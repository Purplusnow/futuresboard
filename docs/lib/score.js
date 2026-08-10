/* 스코어링 — 선물 전용 팩터를 얹은 횡단면 상대평가.
 *
 * 설계 원칙 (COIN BOARD에서 이어받음)
 *  1) 절대 임계값을 쓰지 않는다. 모든 팩터는 그 시점 유니버스 안에서 백분위로 환산한다.
 *     시장 전체가 오르면 모두 만점을 받는 왜곡을 막기 위해서다.
 *  2) 점수만 보여주면 신뢰가 안 생긴다. '이 종목이 유니버스 대비 가장 앞선 지표'를
 *     골라 실제 수치와 함께 근거 태그로 붙인다.
 *  3) 확신도는 숫자가 아니라 기호(◎○△※)로 낸다.
 *
 * 선물에서 새로 들어온 것
 *  - 양방향: 롱/숏 점수를 각각 계산하고 높은 쪽을 방향으로 채택한다.
 *    한쪽 곡선만 쓰면 숏 후보가 구조적으로 저평가된다.
 *  - 펀딩비: 롱이 과밀(펀딩 高)이면 롱에 불리하고 숏에 유리하다. 스팟엔 없는 신호다.
 *  - 미결제약정(OI): 가격과 같은 방향으로 늘면 신규 자금 유입,
 *    반대로 줄면서 가격이 움직이면 청산이 만든 움직임이라 지속력이 약하다.
 */
(function (global) {
  'use strict';

  var I = global.Ind;

  /* 팩터 가중치. 롱·숏 공통으로 쓰되 각 팩터는 방향에 맞게 부호를 뒤집어 넣는다. */
  var WEIGHTS = {
    vol_surge:    0.20,  // 거래량 급증 = 신규 자금. 가장 선행하는 신호
    mom_1h:       0.12,  // 단기 모멘텀
    mom_4h:       0.12,  // 중기 모멘텀
    trend:        0.15,  // 추세 정렬 (역추세 노이즈 배제)
    rsi_q:        0.11,  // 과열/과냉 감점
    efficiency:   0.09,  // 변동성 대비 효율
    oi_align:     0.13,  // OI가 가격과 같은 방향으로 증가하는가 = 신규 포지션
    funding_room: 0.08,  // 펀딩이 아직 그 방향으로 과밀하지 않은가
  };

  /* ------------------------------------------------------------- 피처 추출 */

  /* klines: 바이낸스 원본 배열(오래된 것 → 최신)
   * tick:   24hr ticker (거래대금·24h 등락)
   * mark:   markPrice 스트림 값 { fundingRate, nextFundingTime }
   * oi:     { chgPct } 최근 1시간 미결제약정 변화율 (없으면 null) */
  function buildFeatures(symbol, klines, tick, mark, oi, meta) {
    if (!klines || klines.length < 80) return null;

    var closes = [], highs = [], lows = [], qv = [];
    for (var i = 0; i < klines.length; i++) {
      var k = klines[i];
      closes.push(+k[4]); highs.push(+k[2]); lows.push(+k[3]); qv.push(+k[7]);
    }
    var last = closes[closes.length - 1];
    if (!last) return null;

    var e20 = I.ema(closes, 20), e60 = I.ema(closes, 60);

    // 거래량 급증: 최근 15분(3봉) 평균 vs 직전 6시간(72봉) 평균
    var recent = qv.slice(-3);
    var base = qv.length >= 75 ? qv.slice(-75, -3) : qv.slice(0, -3);
    var rAvg = I.mean(recent), bAvg = I.mean(base);
    var volSurge = (bAvg && bAvg > 0) ? rAvg / bAvg : null;

    var ret15m = I.pctReturn(closes, 3);
    var ret1h = I.pctReturn(closes, 12);
    var ret4h = I.pctReturn(closes, 48);
    var rs = I.rsi(closes, 14);
    var av = I.atrPct(highs, lows, closes, 14);

    // 최근 2시간(24봉) 레인지 내 위치. 1에 가까우면 고점 부근.
    var win = closes.slice(-24);
    var hi = Math.max.apply(null, win), lo = Math.min.apply(null, win);
    var posInRange = hi > lo ? (last - lo) / (hi - lo) : 0.5;

    return {
      symbol: symbol,
      base: (meta && meta.base) || symbol.replace(/USDT$/, ''),
      price: last,
      pricePrecision: (meta && meta.pricePrecision) != null ? meta.pricePrecision : 4,
      onboard: (meta && meta.onboard) || 0,

      ret_15m: ret15m,
      ret_1h: ret1h,
      ret_4h: ret4h,
      ret_24h: tick ? +tick.priceChangePercent : null,
      rsi: rs,
      atr_pct: av,
      vol_surge: volSurge,
      pos_in_range: posInRange,
      ema20: e20,
      ema60: e60,

      // 예상 4시간 변동폭(±%). 방향이 아니라 크기다 — 검증된 것이 이쪽이라 전면에 낸다.
      exp_move: av != null ? av * Math.sqrt(CFG.MOVE_BARS) * CFG.MOVE_K : null,

      qv24: tick ? +tick.quoteVolume : 0,
      funding: mark && mark.fundingRate != null ? mark.fundingRate : null,
      next_funding: mark ? mark.nextFundingTime : null,
      oi_chg: oi && oi.chgPct != null ? oi.chgPct : null,
    };
  }

  /* --------------------------------------------------------- 방향별 팩터값 */

  /* sideSign: 롱 +1, 숏 -1. 모든 팩터를 '클수록 그 방향에 유리'하게 정규화한다. */
  function directional(f, sideSign) {
    var trend = 0;
    if (f.ema20 != null && f.ema60 != null) {
      if (sideSign > 0) {
        if (f.price > f.ema20) trend += 0.5;
        if (f.ema20 > f.ema60) trend += 0.5;
      } else {
        if (f.price < f.ema20) trend += 0.5;
        if (f.ema20 < f.ema60) trend += 0.5;
      }
    }

    var eff = (f.ret_1h != null && f.atr_pct) ? (sideSign * f.ret_1h) / f.atr_pct : null;

    // OI 정렬: OI 증감 × 가격 방향 × 우리 방향.
    // OI↑ & 가격↑ 이면 신규 롱 유입 → 롱에 가점, 숏에 감점.
    var oiAlign = null;
    if (f.oi_chg != null && f.ret_1h != null && f.ret_1h !== 0) {
      oiAlign = f.oi_chg * (f.ret_1h > 0 ? 1 : -1) * sideSign;
    }

    // 펀딩 여유: 롱은 펀딩이 낮/음수일수록 유리(롱이 안 붐빔), 숏은 반대.
    var fundingRoom = f.funding != null ? -sideSign * f.funding : null;

    return {
      vol_surge: f.vol_surge,                        // 방향 무관
      mom_1h: f.ret_1h != null ? sideSign * f.ret_1h : null,
      mom_4h: f.ret_4h != null ? sideSign * f.ret_4h : null,
      trend: trend,
      rsi_q: sideSign > 0 ? I.rsiQuality(f.rsi) : I.rsiQualityShort(f.rsi),
      efficiency: eff,
      oi_align: oiAlign,
      funding_room: fundingRoom,
    };
  }

  function scoreSide(feats, sideSign) {
    var keys = Object.keys(WEIGHTS);
    var dir = feats.map(function (f) { return directional(f, sideSign); });

    var ranked = {};
    keys.forEach(function (k) {
      ranked[k] = I.pctRank(dir.map(function (d) { return d[k]; }));
    });

    return feats.map(function (f, i) {
      var parts = {}, raw = 0;
      keys.forEach(function (k) {
        parts[k] = ranked[k][i];
        raw += WEIGHTS[k] * parts[k];
      });

      // --- 과열 캡: 이미 크게 튄 쪽을 추격하는 것은 위험이 비대칭이다 ---
      var penalty = [];
      if (f.rsi != null) {
        if (sideSign > 0 && f.rsi >= 85) { raw *= 0.75; penalty.push('과열'); }
        if (sideSign < 0 && f.rsi <= 15) { raw *= 0.75; penalty.push('과냉'); }
      }
      if (f.ret_24h != null && sideSign * f.ret_24h >= 40) { raw *= 0.85; penalty.push('급등후'); }

      // 펀딩이 우리 방향으로 이미 과밀하면(8h 0.1% 초과) 청산 연쇄의 표적이 된다.
      // 롱이면 펀딩 高(롱이 숏에 지불), 숏이면 펀딩 低(숏이 롱에 지불)가 과밀 신호다.
      if (f.funding != null && sideSign * f.funding >= 0.001) { raw *= 0.85; penalty.push('펀딩과밀'); }

      return { score: raw * 100, parts: parts, penalty: penalty };
    });
  }

  /* 롱·숏을 각각 매기고 높은 쪽을 채택한다(in-place). */
  function scoreUniverse(feats) {
    if (!feats.length) return;
    var L = scoreSide(feats, +1);
    var S = scoreSide(feats, -1);

    for (var i = 0; i < feats.length; i++) {
      var f = feats[i];
      var win = L[i].score >= S[i].score ? L[i] : S[i];

      f.score = Math.round(win.score * 10) / 10;
      f.side = L[i].score >= S[i].score ? 'LONG' : 'SHORT';
      f.score_long = Math.round(L[i].score * 10) / 10;
      f.score_short = Math.round(S[i].score * 10) / 10;
      f.spread = Math.abs(L[i].score - S[i].score);
      f.parts = {};
      Object.keys(win.parts).forEach(function (k) {
        f.parts[k] = Math.round(win.parts[k] * 100);
      });
      f.penalty = win.penalty;
    }

    // 기호는 절대 점수가 아니라 유니버스 안에서의 위치로 매긴다.
    // 가중 백분위 합은 72~80 같은 좁은 구간에 몰리기 때문에 고정 임계값을 쓰면
    // 시장이 조금만 바뀌어도 전부 ◎가 되거나 전부 ※가 된다. 백분위는 자기보정된다.
    var srank = I.pctRank(feats.map(function (f) { return f.score; }));
    for (var j = 0; j < feats.length; j++) {
      feats[j].pct = Math.round(srank[j] * 1000) / 10;
      feats[j].mark = grade(srank[j], feats[j].spread);
      feats[j].tags = makeTags(feats[j]);
    }
  }

  /* 확신도 기호. 숫자 점수보다 기호가 오해가 적다.
   * pct: 유니버스 내 백분위(0~1). 롱/숏 점수 차가 작으면 방향이 애매하므로 강등한다. */
  function grade(pct, spread) {
    if (spread < 10) return '※';   // 롱·숏이 붙어 있으면 방향 불분명 — 관망
    if (pct >= 0.98) return '◎';   // 상위 2%
    if (pct >= 0.90) return '○';   // 상위 10%
    if (pct >= 0.75) return '△';   // 상위 25%
    return '※';
  }

  /* -------------------------------------------------------------- 근거 태그 */

  function partLabel(key, f) {
    switch (key) {
      case 'vol_surge': {
        var v = f.vol_surge;
        if (v == null) return null;
        return v >= 1.3 ? '거래량 ' + v.toFixed(1) + '배' : '거래량 상위';
      }
      case 'mom_1h': {
        var a = f.ret_1h;
        return (a != null && Math.abs(a) > 0.3) ? '1h ' + fmtPct(a) : null;
      }
      case 'mom_4h': {
        var b = f.ret_4h;
        return (b != null && Math.abs(b) > 0.5) ? '4h ' + fmtPct(b) : null;
      }
      case 'trend':
        return f.side === 'LONG' ? '정배열' : '역배열';
      case 'rsi_q':
        return f.rsi != null ? 'RSI ' + f.rsi.toFixed(0) : null;
      case 'efficiency': {
        // 같은 폭을 움직여도 덜 흔들리며 간 쪽이 우수하다. 배수를 함께 낸다 —
        // '저변동 추세'만 붙이면 모든 종목에 같은 문구가 달려 정보량이 0이 된다.
        if (f.ret_1h == null || !f.atr_pct) return null;
        var mult = Math.abs(f.ret_1h) / f.atr_pct;
        return mult >= 0.8 ? 'ATR대비 ' + mult.toFixed(1) + '배' : null;
      }
      case 'oi_align': {
        var o = f.oi_chg;
        return (o != null && Math.abs(o) >= 1) ? 'OI ' + fmtPct(o) : null;
      }
      case 'funding_room': {
        var fr = f.funding;
        return fr != null ? '펀딩 ' + (fr * 100).toFixed(3) + '%' : null;
      }
    }
    return null;
  }

  function makeTags(f) {
    var parts = f.parts || {};
    var ranked = Object.keys(parts).sort(function (a, b) { return parts[b] - parts[a]; });

    var tags = [];
    for (var i = 0; i < ranked.length && tags.length < 3; i++) {
      if (parts[ranked[i]] < 55) continue;      // 상위 45% 밖이면 강점이라 부를 수 없다
      var lbl = partLabel(ranked[i], f);
      if (lbl && tags.indexOf(lbl) < 0) tags.push(lbl);
    }

    // 선물 고유 상황은 백분위와 무관하게 따로 잡는다.
    if (f.oi_chg != null && f.oi_chg >= 5 && f.ret_1h != null && Math.abs(f.ret_1h) < 0.5) {
      tags.unshift('스퀴즈 임박');             // OI 급증 + 가격 정체 = 에너지 축적
    }
    if (f.onboard && (Date.now() - f.onboard) < CFG.MIN_ONBOARD_DAYS * 864e5) {
      tags.push('신규상장');
    }

    if (!tags.length) {
      tags.push(f.ret_24h != null ? '24h ' + fmtPct(f.ret_24h) : '관망');
    }
    return tags.concat(f.penalty || []).slice(0, 4);
  }

  function fmtPct(v) { return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }

  global.Score = {
    WEIGHTS: WEIGHTS,
    buildFeatures: buildFeatures,
    scoreUniverse: scoreUniverse,
    fmtPct: fmtPct,
  };
})(window);
