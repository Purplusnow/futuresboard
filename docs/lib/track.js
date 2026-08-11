/* 자기검증 패널 — tools/replay.mjs 가 만든 track.json 을 그대로 읽어 보여준다.
 *
 * 이 패널의 목적은 '잘 나온 숫자'를 자랑하는 것이 아니라 검증 가능성을 보이는 것이다.
 * 그래서 다음을 강제한다.
 *
 *  - 베이스라인 대비 초과분을 주 지표로 쓴다. 절대 적중률은 시장 방향만 반영해도 올라간다.
 *  - 유의성 판정(track.verdict)을 헤드라인에 그대로 노출한다.
 *    유의하지 않은데 숫자만 크게 띄우면 자기검증이 아니라 광고가 된다.
 *  - 측정 조건과 한계(caveats)를 화면 안에 둔다. 각주로 숨기지 않는다.
 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function pct(v, digits) {
    return v == null ? '—' : (v * 100).toFixed(digits == null ? 1 : digits) + '%';
  }
  function signed(v, digits) {
    if (v == null) return '—';
    var d = digits == null ? 2 : digits;
    return (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
  }
  function signedP(v) {
    return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + 'p';
  }
  function cls(v) { return v == null ? '' : (v > 0 ? 'up' : (v < 0 ? 'down' : '')); }

  function render(t) {
    $('track').hidden = false;

    $('track-meta').textContent =
      t.window.from.slice(0, 10) + ' ~ ' + t.window.to.slice(0, 10) +
      ' (' + t.window.days + '일) · 종목 ' + t.symbols + '개 · 신호 ' +
      t.signals.toLocaleString() + '건 · ' + t.step_min + '분 간격 평가';

    // 헤드라인 — 검증된 것과 검증되지 않은 것을 나눠서, 둘 다 적는다.
    // 하나만 적으면 어느 쪽을 적든 거짓말이 된다.
    var rb = (t.robust && (t.robust['◎'] || t.robust['전체'])) || null;
    var mv = t.move && t.move['◎|4h'];
    var v = $('track-verdict');
    var html = '';

    if (mv && mv.significant) {
      html += '<b class="ok">검증된 것 — 변동폭 추정.</b> 화면의 「예상 변동 4H」는 59일 실측으로 ' +
        '보정된 값입니다(순위상관 ρ=0.62, 등급별 실측/예상 0.99~1.02배). ' +
        '최고 등급(높음)은 같은 조건 평균보다 <b>' + mv.ratio.toFixed(2) + '배</b> 크게 움직였고 ' +
        '(t=' + mv.t.toFixed(1) + '), 「방향 불분명(※)」 등급은 정확히 평균 수준입니다.';
    }
    // 스코어 순위가 자명한 기준선(ATR 단순정렬)을 못 이긴다는 사실을 먼저 적는다.
    // 이걸 빼면 '평균의 1.9배'가 순위의 공로처럼 읽힌다.
    if (t.vs_atr && !t.vs_atr.score_adds) {
      html += '<br><b class="no">순위의 한계.</b> 다만 이 배수는 대부분 변동성(ATR)에서 나옵니다. ' +
        'ATR로 단순 정렬한 같은 크기의 보드는 <b>' + t.vs_atr.atr_board.toFixed(2) + '%</b> 움직여 ' +
        '스코어 보드(' + t.vs_atr.score_board.toFixed(2) + '%)보다 오히려 큽니다(t=' +
        t.vs_atr.t.toFixed(1) + '). <b>스코어 순위가 단순 ATR 정렬보다 낫다는 근거는 없습니다.</b> ' +
        '그래서 기본 정렬을 「변동 예상」으로 두고, 스코어는 참고용 탭으로 내렸습니다.';
    }
    if (t.verdict !== 'edge') {
      html += '<br><b class="no">검증되지 않은 것 — 방향.</b> ' +
        (rb ? '추천강도 높음 등급의 4시간 평균 수익은 ' + signed(rb.mean) + ' (t=' + rb.t.toFixed(2) +
          ', 유의 기준 |t|≥2), 일별로는 ' + rb.days_total + '일 중 ' + rb.days_positive + '일만 양(+). '
          : '') +
        '<b>롱·숏 방향이 맞는다는 근거는 없습니다.</b> 이 화면은 “무엇이 곧 크게 움직일지”를 ' +
        '고르는 스캐너이지, 어느 쪽으로 갈지를 맞히는 예측기가 아닙니다.';
    } else if (rb) {
      html += '<br><b class="ok">방향 초과성과도 확인됩니다.</b> 추천강도 높음 등급 4시간 평균 ' +
        signed(rb.mean) + ' (t=' + rb.t.toFixed(2) + ').';
    }
    v.dataset.kind = (mv && mv.significant) ? 'partial' : 'none';
    v.innerHTML = html;

    // 등급별 표 — 초과분(baseline 대비)을 주 지표로 둔다
    var rows = [];
    ['◎', '○', '△', '※'].forEach(function (m) {
      if (t.by_mark[m]) rows.push([window.Score ? Score.markLabel(m) : m, t.by_mark[m], 'mark']);
    });
    rows.push(['LONG', t.by_side.LONG, 'side']);
    rows.push(['SHORT', t.by_side.SHORT, 'side']);
    rows.push(['전체', t.overall, 'all']);

    var tbl = '<table class="track-table"><thead><tr><th>등급</th><th>건수</th>';
    t.horizons.forEach(function (h) { tbl += '<th colspan="2">' + h + '</th>'; });
    tbl += '</tr><tr><th></th><th></th>';
    t.horizons.forEach(function () {
      tbl += '<th class="sub">변동폭</th><th class="sub">방향 초과수익</th>';
    });
    tbl += '</tr></thead><tbody>';

    rows.forEach(function (r) {
      var label = r[0], d = r[1], kind = r[2];
      if (!d) return;
      tbl += '<tr data-kind="' + kind + '"><td class="lbl">' + label + '</td>' +
        '<td class="n">' + d.n.toLocaleString() + '</td>';
      t.horizons.forEach(function (h) {
        var c = d[h] || {};
        // 변동폭 배수 — 검증된 지표라 강조한다
        var mv = t.move && t.move[label + '|' + h];
        var ratio = c.move_ratio;
        var big = ratio != null && ratio >= 1.15;
        tbl += '<td class="move' + (big ? ' hot' : '') + '" title="실측 ' +
          (c.absret == null ? '—' : c.absret.toFixed(2) + '%') + ' / 기준 ' +
          (c.base_absret == null ? '—' : c.base_absret.toFixed(2) + '%') +
          (mv ? ' · t=' + mv.t.toFixed(1) : '') + '">' +
          (ratio == null ? '—' : ratio.toFixed(2) + '배') + '</td>';
        // 방향 초과수익 — 유의하지 않으므로 흐리게 둔다
        tbl += '<td class="' + cls(c.edge_ret) + ' dim" title="실측 ' + signed(c.ret) +
          ' / 기준 ' + signed(c.base_ret) + ' · 적중 ' + pct(c.hit) + ' vs ' + pct(c.base_hit) +
          ' (' + signedP(c.edge_hit) + ')">' + signed(c.edge_ret) + '</td>';
      });
      tbl += '</tr>';
    });
    tbl += '</tbody></table>';
    $('track-grid').innerHTML = tbl;

    // 적중률이 왜 주 지표가 아닌지 — 숫자를 보고 오해하기 전에 먼저 말한다
    $('track-note').innerHTML =
      '<b>변동폭</b>은 같은 시각에 노출 기준을 통과한 종목 중 무작위로 골랐을 때 대비 |수익률| 배수입니다. ' +
      '1.00배면 평균과 같다는 뜻입니다. <b>방향 초과수익</b>은 같은 기준 대비 부호를 적용한 평균 수익률 차이이고, ' +
      '셀에 마우스를 올리면 실측·기준·적중률을 볼 수 있습니다. ' +
      '절대 적중률을 쓰지 않는 이유는 시장이 한 방향으로 움직이기만 해도 올라가기 때문입니다.';

    var ul = $('track-caveats');
    ul.innerHTML = '';
    (t.caveats || []).forEach(function (c) {
      var li = document.createElement('li');
      li.textContent = c;
      ul.appendChild(li);
    });

    $('track-gen').textContent = t.generated_at.slice(0, 10) + ' 기준';
  }

  fetch('data/track.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (t) { if (t) render(t); })
    .catch(function () { /* 트랙레코드가 없으면 패널을 띄우지 않는다 */ });
})(window);

/* ---------------------------------------------------------------- 라이브 검증
 *
 * 리플레이(track.json)는 과거 구간이다. 그 결과가 '지금 이 화면'에도 그대로
 * 적용되는지는 별개 문제라서, 브라우저가 실제로 본 신호를 스스로 기록해 대조한다.
 * 표본이 작아 그 자체로 성과를 주장할 수는 없다. 리플레이와 크게 어긋나면
 * 라이브 파이프라인 어딘가가 백테스트와 다르다는 신호로 읽는 용도다.
 *
 * 저장은 localStorage 뿐이다. 방문자마다 따로 쌓이므로 공개 실적이 될 수 없고,
 * 그래서 공개 트랙레코드는 리플레이 쪽이 맡는다.
 */
(function () {
  'use strict';

  var KEY = 'fb.live.v1';
  var SNAP_MS = 30 * 60 * 1000;   // 30분마다 한 번만 기록 (연속 스냅샷은 서로 겹쳐 무의미하다)
  var HORIZON_MS = 60 * 60 * 1000;
  var MAX = 400;
  var TOP = 5;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, JSON.stringify(v.slice(-MAX))); } catch (e) {}
  }

  function tick() {
    var st = window.__fb;
    if (!st || !st.feats || !st.feats.length) return;

    var recs = load();
    var now = Date.now();

    // 1) 아직 결과가 안 난 기록을 현재가로 평가한다
    var changed = false;
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.ret != null || now - r.t < HORIZON_MS) continue;
      var b = st.book[r.symbol];
      if (!b || !(r.entry > 0)) continue;
      var raw = (b.mid / r.entry - 1) * 100;
      r.ret = Math.round((r.side === 'SHORT' ? -raw : raw) * 1000) / 1000;
      changed = true;
    }

    // 2) 스냅샷 주기가 되면 상위 신호를 기록한다
    var last = recs.length ? recs[recs.length - 1].t : 0;
    if (now - last >= SNAP_MS) {
      var board = st.feats
        .filter(function (f) { return f.qv24 >= CFG.MIN_QV_RECO && f.mark !== '※'; })
        .slice(0, TOP);
      board.forEach(function (f) {
        var b = st.book[f.symbol];
        if (!b) return;
        recs.push({ t: now, symbol: f.symbol, side: f.side, mark: f.mark, entry: b.mid, ret: null });
        changed = true;
      });
    }

    if (changed) { save(recs); renderLive(recs); }
  }

  function renderLive(recs) {
    var done = recs.filter(function (r) { return r.ret != null; });
    var el = document.getElementById('track-live');
    if (!el) return;

    if (done.length < 5) {
      el.textContent = '라이브 검증: 이 브라우저에서 관측한 신호 ' + recs.length +
        '건 (결과 확정 ' + done.length + '건). 5건 이상 쌓이면 집계를 표시합니다.';
      return;
    }
    var sum = done.reduce(function (a, r) { return a + r.ret; }, 0);
    var hit = done.filter(function (r) { return r.ret > 0; }).length;
    var mean = sum / done.length;
    el.innerHTML = '라이브 검증(1시간 보유, 이 브라우저 기준): <b>' + done.length + '건</b> · ' +
      '평균 <b class="' + (mean >= 0 ? 'up' : 'down') + '">' +
      (mean >= 0 ? '+' : '') + mean.toFixed(2) + '%</b> · 적중 ' +
      (hit / done.length * 100).toFixed(0) + '% ' +
      '<span class="dimmed">— 표본이 작아 성과 근거로 쓸 수 없습니다. 리플레이와의 대조용입니다.</span>';
  }

  renderLive(load());
  setInterval(tick, 60000);
  setTimeout(tick, 15000);
})();
