/* 알림 엔진 — 규칙(lib/alerts.js)을 라이브 데이터에 걸고 사람에게 전달한다.
 *
 * 서버가 없으므로 푸시는 불가능하다. 탭이 열려 있는 동안만 동작한다(백그라운드 탭 포함).
 * 그 한계를 UI에 명시한다 — "폰 알림처럼 온다"고 오해하면 안 되는 종류의 제약이다.
 *
 * 소음 억제가 이 기능의 절반이다. 알림이 잦으면 안 보게 되고, 안 보면 계기판과 같아진다.
 *   - 같은 (종목, 규칙) 조합은 쿨다운 동안 다시 뜨지 않는다
 *   - 분당 브라우저 알림 수를 캡한다 (피드에는 다 남는다)
 *   - 규칙별 실측 배수를 함께 보여줘 어떤 알림이 값진지 스스로 판단하게 한다
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var KEY_CFG = 'fb.alertcfg.v1';
  var KEY_FEED = 'fb.alertfeed.v1';
  var COOLDOWN_MS = 30 * 60 * 1000;   // 같은 종목·규칙 재알림 간격
  var MAX_NOTIF_PER_MIN = 3;
  // 24시간 재구성분을 담을 수 있어야 한다. 실측 발동 빈도가 하루 100건 안팎이라
  // 60이면 앞부분이 잘려 나가 '24시간'이라는 표기와 화면이 어긋난다.
  var FEED_MAX = 200;

  /* 카드 수명.
   *
   * 알림의 주장은 '4시간 안에 평소보다 크게 움직인다'였다(실측 기준도 4h).
   * 그러니 성적도 4시간까지만 매기고 거기서 얼려야 한다. 계속 갱신하면
   * 12시간 뒤 뒤집힌 결과가 그 알림의 성적처럼 보이는데, 그건 다른 주장이다.
   * 얼린 뒤에는 하루까지만 남기고 지운다 — 어제 신호는 화면에서 의미가 없다. */
  var SETTLE_MS = 4 * 60 * 60 * 1000;
  var EXPIRE_MS = 24 * 60 * 60 * 1000;

  var cfg = loadCfg();
  var feed = loadFeed();
  saveFeed();                       // 접힌 결과를 바로 반영
  var lastFired = {};                  // "sym|rule" -> ts
  var notifTimes = [];
  var unseen = 0;
  var baseTitle = document.title;
  var stats = null;                    // track.json 의 규칙별 실측

  function loadCfg() {
    // 기본값은 실측에서 나왔다(59일 리플레이).
    //   사건형(거래량 폭증·돌파·급변)만 켠다 — 상태형(펀딩·스퀴즈)은 직전 ATR 대비 1.0배로
    //   새 정보가 없어 알림 가치가 없다. 보드의 탭으로 보는 편이 맞다.
    //   강도 2만 알린다 — 강도 1까지 켜면 하루 200회로 소음이 되고, 강도 2는 우위도 더 크다
    //   (거래량 폭증 1.62배 → 강 2.29배).
    var d = { on: false, sound: true, minLevel: 2,
              rules: ['vol_spike', 'breakout', 'impulse'] };
    try {
      var v = JSON.parse(localStorage.getItem(KEY_CFG));
      return v ? Object.assign(d, v) : d;
    } catch (e) { return d; }
  }
  function saveCfg() {
    try { localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); } catch (e) {}
  }
  function loadFeed() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY_FEED)) || []; } catch (e) { return []; }
    return migrate(raw);
  }

  /* 기존 저장분 정리.
   *
   * 종목당 한 장으로 묶는 규칙은 '새로 생기는 카드'에만 적용된다. 이미 브라우저에
   * 쌓여 있던 기록은 규칙마다 한 장씩이라 같은 종목이 여러 개 남아 있다.
   * 저장분도 같은 규칙으로 접어야 화면이 실제로 정리된다.
   *
   * 시간이 멀리 떨어진 것까지 합치면 서로 다른 사건이 한 장이 되므로,
   * 확정 주기(4시간) 안에 있는 것만 같은 사건으로 본다. */
  function migrate(raw) {
    var byKey = {};
    var out = [];

    raw.slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (r) {
      // 옛 형식(rule/label 단수)을 rules 배열로 정규화
      if (!r.rules) {
        r.rules = r.rule ? [{ id: r.rule, label: r.label, level: r.level, dir: r.dir || 0 }] : [];
      }
      var prev = byKey[r.symbol];
      if (prev && r.t - prev.t < SETTLE_MS && prev.settled == null) {
        var known = {};
        prev.rules.forEach(function (x) { known[x.id] = 1; });
        r.rules.forEach(function (x) { if (!known[x.id]) { prev.rules.push(x); known[x.id] = 1; } });
        prev.level = Math.max(prev.level || 1, r.level || 1);
        return;                        // 흡수됐으므로 별도 카드로 남기지 않는다
      }
      byKey[r.symbol] = r;
      out.push(r);
    });

    out.sort(function (a, b) { return b.t - a.t; });   // 최신이 위
    return out;
  }
  function saveFeed() {
    try { localStorage.setItem(KEY_FEED, JSON.stringify(feed.slice(0, FEED_MAX))); } catch (e) {}
  }

  function ruleOn(id) {
    return !cfg.rules || cfg.rules.indexOf(id) >= 0;
  }

  /* 지금 설정(강도)에 해당하는 실측 버킷. 강도 2만 알리면서 강도 1 통계를 보여주면
   * 화면의 숫자가 실제로 받게 될 알림과 달라진다. */
  /* 추천 자격.
   *
   * 확신이 낮으면 방향을 제시하지 않는다. 카드도 합산 성적도 같은 기준을 써야
   * '추천 성적'이라는 말이 성립한다 — 추천하지 않은 건을 성적에 넣으면 안 된다.
   *
   * 참고로 실측은 이 직관과 반대다(확정 100건 기준 건당 순손익):
   *   높음 −4.05% · 보통 −1.74% · 낮음 −0.47%
   * 확신이 높을수록 나쁘다. 그래도 '확신 없는 방향을 내밀지 않는다'는 원칙 자체는
   * 유효하므로 기준을 유지하고, 수치는 자기검증 패널에 그대로 노출한다.
   */
  function levelOf(a) {
    if (a.spread != null && a.spread < 10) return 'unclear';
    return a.pct >= 98 ? 'high' : (a.pct >= 90 ? 'mid' : 'low');
  }
  function isRecommended(a) {
    var lv = levelOf(a);
    return !!a.side && (lv === 'high' || lv === 'mid');
  }

  function statFor(id) {
    if (!stats) return null;
    return (cfg.minLevel >= 2 ? stats[id + '@L2'] : null) || stats[id] || null;
  }

  /* ------------------------------------------------------------------ 평가 */

  function scan() {
    var st = window.__fb;
    if (!st || !st.feats || !st.feats.length) return;

    var now = Date.now();
    var fresh = [];

    for (var i = 0; i < st.feats.length; i++) {
      var f = st.feats[i];
      if (f.qv24 < CFG.MIN_QV_RECO) continue;          // 얇은 호가는 알릴 가치가 없다

      // 한 종목에서 여러 규칙이 동시에 터지는 일이 흔하다(거래량 폭증 + 돌파 + 급변).
      // 규칙마다 카드를 만들면 같은 종목이 여러 장 깔려 다른 종목을 밀어낸다.
      // 오히려 여러 규칙이 겹친 것이 더 강한 사건이므로 한 장에 모아 보여준다.
      var hits = [];
      var fired = Alerts.evaluate(f);
      for (var j = 0; j < fired.length; j++) {
        var hit = fired[j];
        if (!ruleOn(hit.id) || hit.level < cfg.minLevel) continue;
        var key = f.symbol + '|' + hit.id;
        if (now - (lastFired[key] || 0) < COOLDOWN_MS) continue;   // 쿨다운은 규칙별로 유지
        lastFired[key] = now;
        hits.push({ id: hit.id, label: hit.label, level: hit.level, dir: hit.dir || 0 });
      }
      if (!hits.length) continue;

      hits.sort(function (a, b) { return b.level - a.level; });

      // 아직 확정되지 않은 같은 종목 카드가 있으면 거기에 규칙만 더한다.
      var live = null;
      for (var m = 0; m < feed.length; m++) {
        if (feed[m].symbol === f.symbol && feed[m].settled == null) { live = feed[m]; break; }
      }
      if (live) {
        var known = {};
        (live.rules || []).forEach(function (r) { known[r.id] = 1; });
        var added = hits.filter(function (r) { return !known[r.id]; });
        if (added.length) {
          live.rules = (live.rules || []).concat(added);
          live.level = Math.max(live.level, added[0].level);
          fresh.push(live);            // 알림·소리는 새 규칙이 붙었을 때만
        }
        continue;
      }

      fresh.push({
        t: now, symbol: f.symbol, base: f.base,
        rules: hits, level: hits[0].level, dir: hits[0].dir,
        price: f.price, precision: f.pricePrecision,
        exp_move: f.exp_move, ret_1h: f.ret_1h, side: f.side, mark: f.mark,
        pct: f.pct, spread: f.spread,
      });
    }

    // 4시간이 지난 카드는 성적을 확정하고, 하루 지난 카드는 버린다.
    var lifecycleChanged = false;
    var kept = [];
    for (var m = 0; m < feed.length; m++) {
      var c = feed[m];
      if (now - c.t >= EXPIRE_MS) { lifecycleChanged = true; continue; }
      if (c.settled == null && now - c.t >= SETTLE_MS) {
        var bk = st.book[c.symbol];
        if (bk && c.price > 0) {
          var raw = (bk.mid / c.price - 1) * 100;
          c.settled = Math.round((c.side === 'SHORT' ? -raw : raw) * 100) / 100;
          c.settledAt = now;
          lifecycleChanged = true;
        }
      }
      kept.push(c);
    }
    if (lifecycleChanged) { feed = kept; saveFeed(); render(); }

    if (!fresh.length) return;

    // 강한 것부터. 한 번에 많이 뜨면 아래쪽은 피드에만 남는다.
    fresh.sort(function (a, b) { return b.level - a.level; });
    var brandNew = fresh.filter(function (x) { return feed.indexOf(x) < 0; });
    feed = brandNew.concat(feed).slice(0, FEED_MAX);
    saveFeed();
    render();

    if (cfg.on) {
      if (document.hidden) { unseen += fresh.length; updateTitle(); }
      notify(fresh);
      if (cfg.sound) beep(fresh[0].level);
    }
  }

  /* ---------------------------------------------------------------- 전달 */

  function notify(items) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var now = Date.now();
    notifTimes = notifTimes.filter(function (t) { return now - t < 60000; });

    for (var i = 0; i < items.length && notifTimes.length < MAX_NOTIF_PER_MIN; i++) {
      var it = items[i];
      var s = statFor(it.rule);
      try {
        new Notification(it.base + ' — ' + it.label, {
          body: (it.exp_move != null ? '예상 변동 ±' + it.exp_move.toFixed(1) + '% (4h)' : '') +
            (s && s.lift_lag ? ' · 이 조건 뒤 평소의 ' + s.lift_lag.toFixed(1) + '배 움직임' : ''),
          tag: it.symbol + it.rule,           // 같은 알림이 쌓이지 않게
          silent: true,                        // 소리는 우리가 직접 낸다
        });
        notifTimes.push(now);
      } catch (e) { return; }
    }
  }

  /* 외부 오디오 파일 없이 짧은 핑. 정적 배포에 자산을 늘리지 않으려는 것. */
  function beep(level) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = beep.ctx || (beep.ctx = new Ctx());
      if (ctx.state === 'suspended') ctx.resume();
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(level >= 2 ? 880 : 660, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.24);
    } catch (e) {}
  }

  function updateTitle() {
    document.title = unseen > 0 ? '(' + unseen + ') ' + baseTitle : baseTitle;
  }

  /* ------------------------------------------------------------------ 렌더 */

  function fmtPrice(p, prec) {
    if (p == null) return '—';
    var d = prec != null ? Math.min(prec, 8) : 4;
    if (p >= 1000) d = Math.min(d, 1); else if (p >= 1) d = Math.min(d, 4);
    return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function render() {
    var el = $('alert-feed');
    if (!el) return;

    if (!feed.length) {
      el.innerHTML = '<div class="alert-empty">아직 조건에 걸린 종목이 없습니다. ' +
        '규칙이 발동하면 여기에 쌓입니다.</div>';
      return;
    }

    var st = window.__fb;
    var html = '';

    /* 한 종목이 24시간 동안 여러 번 발동하는 것은 정상이다(실측 51종목 107건,
     * 최다 6회). 다만 화면에 같은 종목이 여러 장 깔리면 다른 종목을 밀어낸다.
     * 표시는 종목당 최신 한 장으로 접고 발동 횟수를 배지로 남긴다.
     * 저장은 전건을 유지한다 — 합산 성적은 사건 단위로 세야 정확하다. */
    var latest = [], repeat = {};
    var byS = {};
    for (var q = 0; q < feed.length; q++) {
      var rec = feed[q];
      repeat[rec.symbol] = (repeat[rec.symbol] || 0) + 1;
      if (!byS[rec.symbol] || rec.t > byS[rec.symbol].t) byS[rec.symbol] = rec;
    }
    Object.keys(byS).forEach(function (k) { latest.push(byS[k]); });
    latest.sort(function (a, b) { return b.t - a.t; });

    for (var i = 0; i < latest.length; i++) {
      var a = latest[i];
      var s2 = null;
      (a.rules || [{ id: a.rule }]).forEach(function (r) {
        var v = statFor(r.id);
        if (v && v.lift_lag && (!s2 || v.lift_lag > s2.lift_lag)) s2 = v;
      });

      // 신호 시점 가격 → 현재가. 각 카드가 그 자체로 작은 검증 기록이 된다.
      var settled = a.settled != null;
      var now = (!settled && st && st.book && st.book[a.symbol]) ? st.book[a.symbol].mid : null;
      var chg = (now != null && a.price > 0) ? (now / a.price - 1) * 100 : null;

      // 사건의 방향(무슨 일이 있었나)은 사실이므로 그대로 쓴다.
      var arrow = a.dir > 0 ? '↑' : (a.dir < 0 ? '↓' : '');
      var arrowCls = a.dir > 0 ? 'up' : (a.dir < 0 ? 'down' : '');

      // 예전 형식(rule/label 단수)도 읽을 수 있게 정규화한다.
      var rules = a.rules || [{ id: a.rule, label: a.label, level: a.level }];
      var ruleHtml = rules.map(function (r) {
        return '<span class="ac-rule-item">' + esc(r.label) +
          (r.level >= 2 ? ' <b>강</b>' : '') + '</span>';
      }).join('');

      html += '<div class="alert-card" data-level="' + a.level + '">' +
        '<div class="ac-top"><span class="ac-sym">' + esc(a.base) + '</span>' +
          (repeat[a.symbol] > 1
            ? '<span class="ac-rep" title="최근 24시간 동안 ' + repeat[a.symbol] +
              '번 발동했습니다 (카드는 최신 1건)">' + repeat[a.symbol] + '회</span>' : '') +
        '<span class="ac-time">' + hhmm(a.t) + '</span></div>' +

        '<div class="ac-rule">' + ruleHtml +
          (arrow ? '<span class="ac-arrow ' + arrowCls + '">' + arrow + '</span>' : '') +
        '</div>' +

        '<div class="ac-px">' +
          '<span class="ac-px-at">' + fmtPrice(a.price, a.precision) + '</span>' +
          (chg == null ? ''
            : ' <span class="ac-px-arrow">→</span> <span class="ac-px-now">' + fmtPrice(now, a.precision) + '</span>' +
              ' <span class="ac-px-chg ' + (chg >= 0 ? 'up' : 'down') + '">' +
              (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</span>') +
        '</div>' +

        '<div class="ac-meta">' +
          (a.exp_move != null ? '예상 ±' + a.exp_move.toFixed(1) + '%' : '') +
          (s2 && s2.lift_lag ? ' <span class="ac-stat">· 평소의 ' + s2.lift_lag.toFixed(1) + '배</span>' : '') +
        '</div>' +

        // 스코어가 채택한 진입 방향.
        // 모델이 고른 진입 방향 + 추천강도 + 신호 이후 현재 성적.
        //
        // 기호(◎○△※)는 '방향 불분명'과 '점수 낮음'을 둘 다 ※ 로 뭉개고 있었다.
        // 성격이 다른 두 가지라 말로 풀면서 분리한다.
        //   추천강도  = 스코어 백분위 (높음 상위2% / 보통 10% / 낮음 그 외)
        //   방향불분명 = 롱·숏 점수차 10 미만 — 모델이 방향 자체를 못 고른 경우
        (a.side ? (function () {
          var lv = levelOf(a);
          var rec = isRecommended(a);
          var txt = { high: '추천강도 높음', mid: '추천강도 보통',
                      low: '추천강도 낮음', unclear: '방향 불분명' }[lv];
          var tip = { high: '스코어 상위 2%', mid: '스코어 상위 10%',
                      low: '스코어 상위 25% 밖 — 확신이 낮아 방향을 제시하지 않습니다',
                      unclear: '롱·숏 점수가 붙어 있어 모델이 방향을 고르지 못했습니다' }[lv];

          // 추천하지 않는 등급은 방향을 감춘다. 숨긴 방향이 궁금하면 툴팁으로만 본다.
          var sideHtml = rec
            ? '<span class="ac-entry-side">' + esc(a.side) + '</span>'
            : '<span class="ac-entry-none" title="모델이 기운 방향은 ' + esc(a.side) +
              ' 이지만 확신이 낮아 추천하지 않습니다">추천 없음</span>';

          var pnl = null;
          if (rec) {
            pnl = a.settled != null ? a.settled
              : (chg == null ? null : (a.side === 'SHORT' ? -chg : chg));
          }
          var st2 = '';
          if (!rec) {
            st2 = '<div class="ac-result" data-r="none">' +
              '<span class="ac-result-label">관망</span>' +
              '<span class="ac-result-word">성적 집계 제외</span></div>';
          } else if (pnl == null) {
            st2 = '<div class="ac-result" data-r="wait">' +
              '<span class="ac-result-label">진행중</span>' +
              '<span class="ac-result-word">집계 대기</span></div>';
          } else {
            var done = a.settled != null;
            var cls = pnl > 0 ? 'hit' : 'miss';
            var word = pnl > 0 ? '적중' : '실패';
            var thin = pnl > 0 && pnl < CFG.COST_ROUND_TRIP;
            st2 = '<div class="ac-result" data-r="' + cls + '"' + (done ? ' data-done="1"' : '') + '>' +
              '<span class="ac-result-label">' + (done ? '4h 확정' : '진행중') + '</span>' +
              '<span class="ac-result-word">' + word + '</span>' +
              '<span class="ac-result-pnl">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%</span>' +
              (thin ? '<span class="ac-thin" title="왕복비용 ' + CFG.COST_ROUND_TRIP +
                      '%를 못 넘어 실제로는 남는 것이 없습니다">비용미만</span>' : '') +
              '</div>';
          }

          return '<div class="ac-entry" data-side="' + esc(a.side) + '" data-lv="' + lv + '"' +
            (rec ? '' : ' data-norec="1"') + '>' +
            '<span class="ac-entry-label">진입추천</span>' + sideHtml +
            '<span class="ac-conf" title="' + esc(tip) + '">' + txt + '</span></div>' + st2;
        })() : '') +
        '</div>';
    }
    el.innerHTML = html;

    renderTally();

    var live = feed.filter(function (x) { return x.settled == null; }).length;
    var cnt = $('alert-count');
    if (cnt) {
      if (!feed.length) { cnt.textContent = ''; }
      else {
        // '24시간'이라고 적어두고 실제로는 잘려 있으면 안 되므로 실제 구간을 보여준다.
        var oldest = Math.min.apply(null, feed.map(function (x) { return x.t; }));
        var hrs = Math.round((Date.now() - oldest) / 3600000);
        cnt.textContent = '최근 ' + hrs + '시간 · ' + latest.length + '종목 ' + feed.length +
          '건 · 진행 ' + live + ' · 접속 시점과 무관하게 동일';
      }
    }
  }

  /* 규칙별 실측치 — 임계값이 감이 아니라 측정에서 나왔음을 보이는 자리 */
  function renderRuleStats() {
    var el = $('alert-rulestats');
    if (!el) return;
    var html = '<p class="rule-intro">59일·39,522건 리플레이 실측입니다. 핵심 열은 ' +
      '<b>직전 대비</b> — 사건 <b>직전</b>의 그 종목 변동성 대비 실제로 얼마나 더 움직였는가입니다. ' +
      '1.0배면 “원래 변동성 큰 종목이었을 뿐”이라 알릴 가치가 없습니다.</p>' +
      '<table class="rule-table"><thead><tr><th>규칙</th><th>조건</th>' +
      '<th>발동/일</th><th>4h 변동</th><th>직전 대비</th><th></th></tr></thead><tbody>';
    Alerts.RULES.forEach(function (r) {
      var s = statFor(r.id);
      var on = ruleOn(r.id);
      var good = s && s.beats_prior_atr;
      html += '<tr' + (on ? '' : ' class="rt-off"') + '><td class="rt-name">' + esc(r.label) +
          (on ? '' : ' <span class="rt-ns">꺼짐</span>') + '</td>' +
        '<td class="rt-desc">' + esc(r.desc) + '</td>' +
        '<td class="rt-n">' + (s ? s.per_day.toFixed(0) + '회' : '—') + '</td>' +
        '<td>' + (s ? s.h4.toFixed(2) + '%' : '—') + '</td>' +
        '<td class="' + (good ? 'rt-hot' : '') + '">' +
          (s && s.lift_lag ? s.lift_lag.toFixed(2) + '배' +
            (s.lift_lag_t != null ? ' <span class="rt-ns">t=' + s.lift_lag_t.toFixed(1) + '</span>' : '')
            : '—') + '</td>' +
        '<td class="rt-verdict">' + (s ? (good ? '새 정보' : '평소 수준') : '—') + '</td></tr>';
    });
    html += '</tbody></table>' +
      '<p class="rule-intro">펀딩 극단과 스퀴즈는 직전 대비 1.0배라 기본으로 꺼 두었습니다. ' +
      '해당 종목이 원래 변동성이 크다는 뜻이라 알림보다 보드의 탭으로 보는 편이 맞습니다.</p>';
    el.innerHTML = html;
  }

  function hhmm(t) {
    var d = new Date(t);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }



  /* 카드 전체 합산 성적 — 전광판.
   *
   * 피드가 접속 시점과 무관하게 동일해졌으므로 이 합계도 모든 방문자에게 같다.
   * 그래서 비로소 '공개된 성적'이라고 부를 수 있다.
   *
   * 헤드라인은 반드시 비용을 뺀 값이다. 각 카드는 왕복 매매 하나에 해당하므로
   * 건당 왕복비용을 그대로 차감한다. 총수익만 크게 띄우면 이 사이트가 여태
   * 지켜온 기준을 화면 맨 위에서 스스로 어기는 셈이 된다.
   *
   * 확정분(4시간 경과)만 집계한다. 진행 중인 카드를 섞으면 아직 끝나지 않은
   * 거래가 성적표에 들어가고, 시간이 갈수록 숫자가 흔들린다.
   */
  function renderTally() {
    var el = $('alert-tally');
    if (!el) return;

    // 추천하지 않은 건은 '추천 성적'에 넣지 않는다.
    var rec = feed.filter(isRecommended);
    var done = rec.filter(function (x) { return x.settled != null; });
    var live = rec.length - done.length;
    var skipped = feed.length - rec.length;

    if (done.length < 3) {
      el.hidden = false;
      el.innerHTML = '<div class="tl-wait">확정된 추천이 ' + done.length +
        '건입니다. 3건 이상 쌓이면 합산 성적을 표시합니다. (진행 중 ' + live +
        '건 · 확신 부족으로 추천 제외 ' + skipped + '건)</div>';
      return;
    }

    var cost = CFG.COST_ROUND_TRIP;
    var gross = done.reduce(function (a, x) { return a + x.settled; }, 0);
    var net = gross - cost * done.length;
    var hit = done.filter(function (x) { return x.settled - cost > 0; }).length;
    var span = Math.round((Date.now() - Math.min.apply(null, done.map(function (x) { return x.t; }))) / 3600000);

    var sign = net >= 0 ? 'up' : 'down';
    el.hidden = false;
    el.innerHTML =
      '<div class="tl-head">' +
        '<span class="tl-title">추천 합산 성적</span>' +
        '<span class="tl-sub">확정 ' + done.length + '건 (' +
          Object.keys(done.reduce(function (a, x) { a[x.symbol] = 1; return a; }, {})).length +
          '종목) · 확신 부족 제외 ' + skipped + '건 · 최근 ' + span + '시간 · ' +
          '진입 다음 봉, 청산 4시간 뒤 · 왕복비용 ' + cost + '% 반영</span>' +
      '</div>' +
      '<div class="tl-body">' +
        '<div class="tl-main ' + sign + '">' +
          '<span class="tl-num">' + (net >= 0 ? '+' : '') + net.toFixed(2) + '%</span>' +
          '<span class="tl-cap">순손익 합계</span>' +
        '</div>' +
        '<div class="tl-cells">' +
          cell('평균', (net / done.length >= 0 ? '+' : '') + (net / done.length).toFixed(3) + '%',
               net / done.length >= 0 ? 'up' : 'down') +
          cell('적중', (hit / done.length * 100).toFixed(0) + '%', '') +
          cell('총수익', (gross >= 0 ? '+' : '') + gross.toFixed(2) + '%', gross >= 0 ? 'up' : 'down') +
          cell('비용', '−' + (cost * done.length).toFixed(2) + '%', 'down') +
          cell('진행중', live + '건', '') +
        '</div>' +
      '</div>';
  }

  function cell(label, val, cls) {
    return '<div class="tl-cell"><span class="tl-cell-v ' + cls + '">' + val + '</span>' +
      '<span class="tl-cell-l">' + label + '</span></div>';
  }

  /* ------------------------------------------------------------ 과거 재구성
   *
   * 알림을 브라우저에서 계산하면 '창을 언제 열었는가'에 따라 사람마다 피드가 달라진다.
   * 방금 들어온 사람은 빈 화면을, 6시간 열어둔 사람은 6시간치를 본다. 같은 사이트가
   * 사람마다 다른 것을 보여주면 그건 공개된 신호라고 하기 어렵다.
   *
   * 그런데 알림 규칙은 순수 함수다(리플레이가 같은 파일을 로드하도록 그렇게 만들었다).
   * 같은 봉이 있으면 누가 언제 계산하든 결과가 같다. 그래서 부팅 시 과거 24시간을
   * 그대로 되돌려 재구성한다. 결과적으로 모든 방문자가 동일한 피드에서 출발한다.
   *
   * 비용은 0이다 — 봉을 200개 대신 488개 받는데 바이낸스 weight가 둘 다 2다(실측).
   *
   * 한계 두 가지를 명시해 둔다.
   *  - 유동성 필터(qv24)는 '지금' 값을 쓴다. 과거 시점의 24h 거래대금을 정확히 내려면
   *    봉이 288개 더 필요한데, 지금 유동한 종목은 하루 전에도 대체로 유동했다.
   *  - 펀딩·OI를 쓰는 규칙(펀딩 극단·스퀴즈)은 과거 값을 못 구해 재구성에서 제외한다.
   *    둘 다 기본으로 꺼져 있고, 실측에서 '새 정보 없음'으로 판정된 규칙들이다.
   */
  var BACKFILL_RULES = { vol_spike: 1, breakout: 1, impulse: 1 };
  var backfilled = false;

  /* 시각별로 처리해야 한다.
   *
   * 처음엔 종목별로 돌면서 buildFeatures 만 불렀는데, side·pct·spread·mark 는
   * scoreUniverse 가 '같은 시각의 다른 종목들과 비교해서' 정하는 값이다.
   * 그걸 빼먹으니 전부 undefined 가 됐고, 진입추천이 안 뜨는 것은 물론
   * 성적 계산이 side !== 'SHORT' 로 흘러 전 건이 롱으로 채점되고 있었다.
   * 스코어링이 횡단면인 이상 재구성도 횡단면이어야 한다. */
  function backfill() {
    var st = window.__fb;
    if (backfilled || !st || !st.booted || !st.universe || !st.universe.length) return;
    backfilled = true;

    // 종목마다 상장 시점이 달라 배열 인덱스가 같은 시각을 가리키지 않는다. 시각으로 찾는다.
    var idx = {}, syms = [];
    st.universe.forEach(function (sym) {
      var kl = st.bars[sym], tk = st.tickers[sym];
      if (!kl || kl.length < CFG.BARS + 10 || !tk) return;
      if (+tk.quoteVolume < CFG.MIN_QV_RECO) return;
      var m = {};
      for (var i = 0; i < kl.length; i++) m[kl[i][0]] = i;
      idx[sym] = m;
      syms.push(sym);
    });
    if (syms.length < 20) return;

    // 기준 시각축은 가장 봉이 많은 종목에서 가져온다
    var ref = syms.reduce(function (a, b) {
      return st.bars[b].length > st.bars[a].length ? b : a;
    }, syms[0]);
    var refKl = st.bars[ref];
    var times = [];
    for (var j = Math.max(CFG.BARS, refKl.length - CFG.BACKFILL_BARS); j < refKl.length; j += CFG.BACKFILL_STEP) {
      times.push(refKl[j][0]);
    }

    var now = Date.now();
    var made = [], seen = {};
    var ti = 0;

    // 한 번에 다 돌면 UI가 멈춘다. 시각 단위로 끊어가며 처리한다.
    function chunk() {
      var deadline = Date.now() + 40;
      while (ti < times.length && Date.now() < deadline) {
        step(times[ti++]);
      }
      if (ti < times.length) { setTimeout(chunk, 0); return; }
      finish();
    }

    function step(t) {
      var feats = [];
      for (var k = 0; k < syms.length; k++) {
        var sym = syms[k];
        var i = idx[sym][t];
        if (i == null || i < CFG.BARS - 1) continue;
        var bars = st.bars[sym].slice(i - CFG.BARS + 1, i + 1);
        if (bars.length < CFG.BARS) continue;
        // 과거 시점이라 펀딩·OI 는 넘기지 않는다(그때 값을 모른다)
        var f = Score.buildFeatures(sym, bars, st.tickers[sym], null, null, st.meta[sym] || {});
        if (f) { f._i = i; feats.push(f); }
      }
      if (feats.length < 20) return;

      Score.scoreUniverse(feats);        // ← 이것이 side·pct·spread·mark 를 채운다

      for (var q = 0; q < feats.length; q++) {
        var f2 = feats[q];
        var kl = st.bars[f2.symbol];
        var barT = kl[f2._i][6];
        if (now - barT > EXPIRE_MS) continue;

        var hits = Alerts.evaluate(f2).filter(function (h) {
          return BACKFILL_RULES[h.id] && ruleOn(h.id) && h.level >= cfg.minLevel;
        }).filter(function (h) {
          var key = f2.symbol + '|' + h.id;
          if (barT - (seen[key] || 0) < COOLDOWN_MS) return false;
          seen[key] = barT;
          return true;
        });
        if (!hits.length) continue;
        hits.sort(function (a, b) { return b.level - a.level; });

        var entry = +kl[f2._i][4];
        var settled = null;
        var exitIdx = f2._i + 48;
        if (now - barT >= SETTLE_MS && exitIdx < kl.length && entry > 0) {
          var raw = (+kl[exitIdx][4] / entry - 1) * 100;
          settled = Math.round((f2.side === 'SHORT' ? -raw : raw) * 100) / 100;
        }

        made.push({
          t: barT, symbol: f2.symbol, base: f2.base, rules: hits,
          level: hits[0].level, dir: hits[0].dir || 0,
          price: entry, precision: f2.pricePrecision,
          exp_move: f2.exp_move, ret_1h: f2.ret_1h, side: f2.side, mark: f2.mark,
          pct: f2.pct, spread: f2.spread, settled: settled, bf: 1,
        });
      }
    }

    function finish() {
      if (!made.length) return;
      Object.keys(seen).forEach(function (k) {
        if (!lastFired[k] || lastFired[k] < seen[k]) lastFired[k] = seen[k];
      });
      var have = {};
      feed.forEach(function (x) { have[x.symbol + '|' + Math.floor(x.t / COOLDOWN_MS)] = 1; });
      var add = made.filter(function (x) {
        return !have[x.symbol + '|' + Math.floor(x.t / COOLDOWN_MS)];
      });
      feed = feed.concat(add).sort(function (a, b) { return b.t - a.t; }).slice(0, FEED_MAX);
      saveFeed();
      render();
    }

    chunk();
  }

  /* ------------------------------------------------------------------ 제어 */

  function setBtn() {
    var b = $('alert-toggle');
    if (!b) return;
    var granted = ('Notification' in window) && Notification.permission === 'granted';
    b.textContent = cfg.on ? (granted ? '알림 켜짐' : '알림 켜짐 (탭 내 표시만)') : '알림 켜기';
    b.dataset.on = cfg.on ? '1' : '0';
    var s = $('alert-sound');
    if (s) { s.dataset.on = cfg.sound ? '1' : '0'; s.title = cfg.sound ? '소리 끄기' : '소리 켜기'; }
  }

  function init() {
    render();

    var t = $('alert-toggle');
    if (t) {
      t.addEventListener('click', function () {
        cfg.on = !cfg.on;
        saveCfg();
        if (cfg.on && 'Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission().then(setBtn);   // 권한 요청은 사용자 조작에서만 가능하다
        }
        if (cfg.on) beep(1);
        setBtn();
      });
    }
    var s = $('alert-sound');
    if (s) {
      s.addEventListener('click', function () { cfg.sound = !cfg.sound; saveCfg(); setBtn(); });
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { unseen = 0; updateTitle(); }
    });
    setBtn();

    fetch('data/track.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) {
        if (t && t.alerts) { stats = t.alerts; render(); renderRuleStats(); }
      })
      .catch(function () {});

    // 부팅이 끝나는 대로 과거 24시간을 재구성한다(봉이 준비된 뒤여야 한다).
    var bfTimer = setInterval(function () {
      if (window.__fb && window.__fb.booted) { clearInterval(bfTimer); backfill(); }
    }, 1000);

    setInterval(scan, 5000);
    // 신호 시점 대비 현재가를 계속 갱신한다. 새 알림이 없어도 카드가 살아 있어야 한다.
    setInterval(render, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
