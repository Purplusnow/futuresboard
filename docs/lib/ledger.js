/* 매매 원장 패널 — "추천대로 매매했다면 얼마를 벌었나"를 비용까지 넣어 보여준다.
 *
 * 이 패널의 존재 이유는 자랑이 아니라 반증 가능성이다. 지금 숫자는 전 전략 손실이고,
 * 그 사실을 가장 크게 적는다. 스크리너가 "수익이 난다"고 말하려면 이 표가 먼저 바뀌어야 한다.
 *
 * 백테스트 구간과 전진 검증 구간을 절대 합치지 않는다. 합치는 순간
 * "과거에 맞춰 튜닝했을 수 있다"는 의심을 다시 뒤집어쓴다.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function pc(v, d) {
    if (v == null) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(d == null ? 3 : d) + '%';
  }
  function cls(v) { return v == null ? '' : (v > 0 ? 'up' : (v < 0 ? 'down' : '')); }

  function aggregate(L, mode) {
    var out = {};
    Object.keys(L.days).forEach(function (day) {
      var d = L.days[day];
      if ((d.mode || 'backtest') !== mode) return;
      Object.keys(d.strat).forEach(function (sid) {
        var a = d.strat[sid];
        var o = out[sid] || (out[sid] = { n: 0, gross: 0, net: 0, wins: 0, days: 0 });
        o.n += a.n; o.gross += a.gross; o.net += a.net; o.wins += a.wins; o.days++;
      });
    });
    return out;
  }

  function table(L, agg, title, note) {
    var ids = Object.keys(agg);
    if (!ids.length) {
      return '<div class="lg-block"><h3>' + title + '</h3>' +
        '<p class="lg-empty">' + note + '</p></div>';
    }
    var html = '<div class="lg-block"><h3>' + title + '</h3>' +
      '<p class="lg-note">' + note + '</p>' +
      '<table class="lg-table"><thead><tr><th>전략</th><th>매매</th>' +
      '<th>평균 총수익</th><th>평균 순수익</th><th>승률</th></tr></thead><tbody>';

    (L.strategies || []).forEach(function (st) {
      var a = agg[st.id];
      if (!a) return;
      var avgNet = a.net / a.n, avgGross = a.gross / a.n;
      html += '<tr><td class="lg-name" title="' + esc(st.note || '') + '">' + esc(st.label) + '</td>' +
        '<td class="lg-n">' + a.n.toLocaleString() + '</td>' +
        '<td class="' + cls(avgGross) + ' dim">' + pc(avgGross) + '</td>' +
        '<td class="' + cls(avgNet) + ' lg-strong">' + pc(avgNet) + '</td>' +
        '<td class="lg-n">' + (a.wins / a.n * 100).toFixed(1) + '%</td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  function render(L) {
    $('ledger').hidden = false;

    var back = aggregate(L, 'backtest');
    var fwd = aggregate(L, 'forward');
    var days = Object.keys(L.days).sort();

    $('ledger-meta').textContent =
      (days.length ? days[0] + ' ~ ' + days[days.length - 1] + ' (' + days.length + '일)' : '') +
      ' · 보유 ' + L.hold_hours + '시간 · ' + L.step_min + '분마다 신호 · 갱신 ' +
      (L.updated_at || '').slice(0, 10);

    // 헤드라인 — 지금 사실은 "전부 손실"이다. 이걸 맨 위에 크게 적는다.
    var m = back.model_dir, c = back.control_random;
    var v = $('ledger-verdict');
    if (m) {
      var avg = m.net / m.n;
      v.dataset.kind = avg > 0 ? 'ok' : 'loss';
      v.innerHTML = '<b>비용을 반영하면 매매당 평균 ' + pc(avg) + '입니다.</b> ' +
        '왕복 수수료·슬리피지 ' + L.cost.round_trip.toFixed(2) + '%에 펀딩 실비를 더한 결과입니다. ' +
        '측정된 방향 우위가 비용보다 작아서 <b>추천대로 매매하면 손실이 납니다.</b> ' +
        '반대로 매매해도 마찬가지고(' + (back.model_fade ? pc(back.model_fade.net / back.model_fade.n) : '—') +
        '), 아무거나 사도 비용만큼 잃습니다(' + (c ? pc(c.net / c.n) : '—') + '). ' +
        '이 표가 양(+)으로 바뀌기 전까지 이 사이트는 수익을 주장하지 않습니다.';
    }

    var html = table(L, back, '백테스트 구간',
      '모델을 만든 뒤 과거 데이터로 되돌린 결과입니다. 과거에 맞춰 조정했을 가능성을 배제할 수 없습니다.');
    html += table(L, fwd, '전진 검증 구간 (모델 동결 ' + (L.freeze_date || '') + ' 이후)',
      Object.keys(fwd).length
        ? '동결 이후 새로 생긴 데이터만 사용합니다. 데이터가 모델보다 나중이라 과최적화가 불가능합니다.'
        : '아직 누적된 날이 없습니다. 매일 자동으로 하루치씩 쌓입니다 — 이 칸이 채워져야 진짜 검증입니다.');
    $('ledger-grid').innerHTML = html;

    $('ledger-cost').textContent =
      '비용 가정: 테이커 ' + L.cost.taker_fee + '% × 2 + 슬리피지 ' + L.cost.slippage +
      '% × 2 = 왕복 ' + L.cost.round_trip.toFixed(2) + '%, 여기에 보유 중 발생한 펀딩을 실비로 더합니다. ' +
      '진입은 신호 다음 봉 시가, 청산은 ' + L.hold_hours + '시간 뒤 종가입니다.';
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  fetch('data/ledger.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (L) { if (L && L.days) render(L); })
    .catch(function () { /* 원장이 없으면 패널을 띄우지 않는다 */ });
})();
