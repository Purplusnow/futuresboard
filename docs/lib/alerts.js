/* 알림 규칙 — 계기판을 트리거로 바꾸는 부분.
 *
 * 화면을 계속 보고 있을 사람은 없다. 그래서 "지금 볼 만한 일이 생겼다"를
 * 알려주는 쪽이 계기판 자체보다 쓸모가 크다.
 *
 * 다만 임계값을 감으로 정하면 알림은 그냥 소음이 된다. 그래서 규칙을 여기 한 곳에
 * 순수 함수로 두고, 리플레이(tools/replay.mjs)가 **같은 파일을 로드해서** 규칙별로
 * "발생 후 실제로 얼마나 움직였는지"를 측정한다. 측정 결과는 track.json에 담겨
 * 알림 옆에 그대로 표시된다 — 근거 없는 임계값을 팔지 않기 위한 장치다.
 *
 * 규칙은 전부 '방향'이 아니라 '사건'을 잡는다. 방향 예측력은 검증되지 않았고,
 * 검증된 것은 변동폭뿐이기 때문이다.
 */
(function (global) {
  'use strict';

  /* 각 규칙: (f) => null | { level }
   * f 는 Score.buildFeatures 결과. 규칙은 부작용이 없어야 한다(리플레이가 수만 번 호출한다). */
  var RULES = [
    {
      id: 'vol_spike',
      kind: 'event',
      label: '거래량 폭증',
      desc: '최근 15분 거래대금이 직전 6시간 평균의 4배 이상',
      test: function (f) {
        if (f.vol_surge == null) return null;
        var d = (f.ret_15m || 0) >= 0 ? 1 : -1;      // 급증이 상승 중이었나 하락 중이었나
        if (f.vol_surge >= 8) return { level: 2, dir: d };
        if (f.vol_surge >= 4) return { level: 1, dir: d };
        return null;
      },
    },
    {
      id: 'breakout',
      kind: 'event',
      label: '거래량 동반 돌파',
      desc: '최근 2시간 레인지 상·하단에 붙으면서 거래량이 평소의 2배 이상',
      test: function (f) {
        if (f.pos_in_range == null || f.vol_surge == null) return null;
        if (f.vol_surge < 2) return null;
        var up = f.pos_in_range >= 0.97, dn = f.pos_in_range <= 0.03;
        if (!up && !dn) return null;
        return { level: f.vol_surge >= 4 ? 2 : 1, dir: up ? 1 : -1 };
      },
    },
    {
      id: 'squeeze',
      kind: 'state',
      label: '스퀴즈 임박',
      desc: '미결제약정이 1시간 새 5% 이상 늘었는데 가격은 제자리 — 에너지 축적',
      test: function (f) {
        if (f.oi_chg == null || f.ret_1h == null) return null;
        if (f.oi_chg >= 5 && Math.abs(f.ret_1h) < 0.5) return { level: 2, dir: 0 };
        return null;
      },
    },
    {
      id: 'funding_extreme',
      kind: 'state',
      label: '펀딩 극단',
      desc: '펀딩비 절대값이 8시간 0.1% 이상 — 한쪽으로 과밀',
      test: function (f) {
        if (f.funding == null) return null;
        var fd = f.funding > 0 ? 1 : -1;             // 양수 = 롱이 지불(롱 과밀)
        if (Math.abs(f.funding) >= 0.003) return { level: 2, dir: fd };
        if (Math.abs(f.funding) >= 0.001) return { level: 1, dir: fd };
        return null;
      },
    },
    {
      id: 'impulse',
      kind: 'event',
      label: '급변',
      desc: '최근 15분 변동이 자기 ATR의 2.5배 이상 — 평소와 다른 봉',
      test: function (f) {
        if (f.ret_15m == null || !f.atr_pct) return null;
        var z = Math.abs(f.ret_15m) / f.atr_pct;
        var id2 = f.ret_15m >= 0 ? 1 : -1;
        if (z >= 4) return { level: 2, dir: id2 };
        if (z >= 2.5) return { level: 1, dir: id2 };
        return null;
      },
    },
  ];

  var BY_ID = {};
  RULES.forEach(function (r) { BY_ID[r.id] = r; });

  /* 한 종목에 대해 발동한 규칙 목록. 리플레이와 라이브가 같은 경로를 쓴다. */
  function evaluate(f) {
    var out = [];
    for (var i = 0; i < RULES.length; i++) {
      var hit = RULES[i].test(f);
      if (hit) out.push({ id: RULES[i].id, label: RULES[i].label,
                         level: hit.level, dir: hit.dir == null ? 0 : hit.dir });
    }
    return out;
  }

  global.Alerts = { RULES: RULES, BY_ID: BY_ID, evaluate: evaluate };
})(typeof window !== 'undefined' ? window : globalThis);
