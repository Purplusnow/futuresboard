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
  var FEED_MAX = 60;

  var cfg = loadCfg();
  var feed = loadFeed();
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
    try { return JSON.parse(localStorage.getItem(KEY_FEED)) || []; } catch (e) { return []; }
  }
  function saveFeed() {
    try { localStorage.setItem(KEY_FEED, JSON.stringify(feed.slice(0, FEED_MAX))); } catch (e) {}
  }

  function ruleOn(id) {
    return !cfg.rules || cfg.rules.indexOf(id) >= 0;
  }

  /* 지금 설정(강도)에 해당하는 실측 버킷. 강도 2만 알리면서 강도 1 통계를 보여주면
   * 화면의 숫자가 실제로 받게 될 알림과 달라진다. */
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

      var fired = Alerts.evaluate(f);
      for (var j = 0; j < fired.length; j++) {
        var hit = fired[j];
        if (!ruleOn(hit.id) || hit.level < cfg.minLevel) continue;

        var key = f.symbol + '|' + hit.id;
        if (now - (lastFired[key] || 0) < COOLDOWN_MS) continue;
        lastFired[key] = now;

        fresh.push({
          t: now, symbol: f.symbol, base: f.base, rule: hit.id, label: hit.label,
          level: hit.level, price: f.price, precision: f.pricePrecision,
          exp_move: f.exp_move, ret_1h: f.ret_1h, side: f.side, mark: f.mark,
        });
      }
    }

    if (!fresh.length) return;

    // 강한 것부터. 한 번에 많이 뜨면 아래쪽은 피드에만 남는다.
    fresh.sort(function (a, b) { return b.level - a.level; });
    feed = fresh.concat(feed).slice(0, FEED_MAX);
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

  function render() {
    var el = $('alert-feed');
    if (!el) return;

    if (!feed.length) {
      el.innerHTML = '<div class="alert-empty">아직 조건에 걸린 종목이 없습니다. ' +
        '규칙이 발동하면 여기에 쌓입니다.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < Math.min(feed.length, 24); i++) {
      var a = feed[i];
      var s = statFor(a.rule);
      html += '<div class="alert-card" data-level="' + a.level + '">' +
        '<div class="ac-top"><span class="ac-sym">' + esc(a.base) + '</span>' +
        '<span class="ac-time">' + hhmm(a.t) + '</span></div>' +
        '<div class="ac-rule">' + esc(a.label) + (a.level >= 2 ? ' <b>강</b>' : '') + '</div>' +
        '<div class="ac-meta">' +
          (a.exp_move != null ? '예상 ±' + a.exp_move.toFixed(1) + '%' : '') +
          (s && s.lift_lag ? ' <span class="ac-stat">· 평소의 ' + s.lift_lag.toFixed(1) + '배</span>' : '') +
        '</div></div>';
    }
    el.innerHTML = html;
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

    setInterval(scan, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
