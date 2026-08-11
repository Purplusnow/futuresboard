/* FUTURES BOARD — 오케스트레이션
 *
 * 부팅 흐름 (총 REST weight ≈ 350, 한도 2400/분)
 *   exchangeInfo(1) → ticker/24hr 전체(40) → premiumIndex 전체(10)
 *   → 거래대금 상위 150종목 5m 캔들 시딩(150×2=300)
 *
 * ── 실시간 경로에 대하여 ────────────────────────────────────────────────
 * 처음에는 kline/markPrice/ticker 스트림으로 전부 WS에서 받으려 했으나,
 * 실측 결과 fstream에서 스트림 계열별로 수신이 갈렸다(노드·크롬 동일, 6회 재현):
 *
 *     ✓ bookTicker · depth · trade
 *     ✗ kline_* · aggTrade · markPrice · miniTicker · ticker · forceOrder
 *     ✗ !ticker@arr  (현물 호스트에서도 동일하게 0프레임)
 *
 * 같은 IP에서 REST는 정상이고 현물 호스트에서는 kline/aggTrade가 살아 있다.
 * 원인을 확정하지 못했으므로 원인에 기대지 않는 설계를 택한다.
 *
 *   실시간 가격 : !bookTicker (전 종목 최우선 호가, 초당 ~90건) — 확실히 살아 있는 스트림
 *   봉/펀딩/24h : REST 폴링 (합계 ~370 weight/분, 한도 2400의 15%)
 *   kline WS    : 구독은 하되 8초 안에 프레임이 안 오면 죽은 것으로 보고 REST로 전환.
 *                 살아 있는 환경에서는 그만큼 REST를 아낀다.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    meta: {},        // symbol -> { base, pricePrecision, onboard }
    universe: [],    // 스코어링 대상 심볼
    tickers: {},     // symbol -> 24hr ticker
    marks: {},       // symbol -> { markPrice, fundingRate, nextFundingTime }
    bars: {},        // symbol -> kline 배열 (오래된 것 → 최신)
    oi: {},          // symbol -> { chgPct }
    feats: [],       // 스코어링 결과
    view: 'move',
    lastPrice: {},   // 플래시용 직전 가격
    book: {},        // symbol -> { bid, ask, mid }  (실시간 가격의 단일 출처)
    rowEls: new Map(),
    booted: false,
    klineWS: null,   // null=판정 전, true=WS로 봉이 옴, false=REST 폴백
    rx: { book: 0, kline: 0 },
    order: { view: null, syms: [], ts: 0 },   // 화면에 고정된 표시 순서
    marqueeTs: 0,
  };

  // 콘솔/자동화에서 내부 상태를 들여다볼 수 있게 열어둔다.
  window.__fb = state;

  /* ------------------------------------------------------------------ 부팅 */

  async function boot() {
    try {
      setMeta('종목 목록 조회 중…');
      var syms = await Binance.perpetualSymbols();
      syms.forEach(function (s) { state.meta[s.symbol] = s; });

      setMeta('전 종목 시세 조회 중…');
      var ticks = await Binance.ticker24h();
      ticks.forEach(function (t) { state.tickers[t.symbol] = t; });

      // 거래대금 상위로 유니버스 확정. 백분위는 표본이 얇으면 왜곡되므로 넓게 잡는다.
      var cand = [];
      Object.keys(state.meta).forEach(function (sym) {
        var t = state.tickers[sym];
        if (!t) return;
        var qv = +t.quoteVolume;
        if (qv < CFG.MIN_QV_UNIVERSE) return;
        cand.push([qv, sym]);
      });
      cand.sort(function (a, b) { return b[0] - a[0]; });
      state.universe = cand.slice(0, CFG.UNIVERSE_SIZE).map(function (x) { return x[1]; });

      setMeta('펀딩비 조회 중…');
      var prem = await Binance.premiumIndex();
      prem.forEach(function (p) {
        state.marks[p.symbol] = {
          markPrice: +p.markPrice,
          fundingRate: +p.lastFundingRate,
          nextFundingTime: p.nextFundingTime,
        };
      });

      await Binance.klinesBatch(
        state.universe, CFG.INTERVAL, CFG.BARS, 8,
        function (done, total) {
          setMeta('캔들 시딩 ' + done + '/' + total + '…');
          if (done % 10 === 0) setWeight();
        }
      ).then(function (map) {
        Object.keys(map).forEach(function (sym) {
          if (map[sym]) state.bars[sym] = map[sym];
        });
      });

      // 캔들 시딩에 실패한 종목은 유니버스에서 뺀다(피처를 만들 수 없다)
      state.universe = state.universe.filter(function (s) { return !!state.bars[s]; });

      connectSocket();
      rescore();
      state.booted = true;

      setInterval(rescore, CFG.RESCORE_MS);
      setInterval(refreshTickers, CFG.TICKER_POLL_MS);
      setInterval(refreshFunding, CFG.FUNDING_POLL_MS);
      setInterval(pollOI, CFG.OI_POLL_MS);
      pollOI();
    } catch (e) {
      showError(e);
    }
  }

  /* -------------------------------------------------------------- WebSocket */

  function connectSocket() {
    // !bookTicker 는 전 종목 최우선 호가를 한 스트림으로 준다. 실측상 fstream에서
    // 확실히 살아 있는 유일한 전 종목 스트림이라 실시간 가격의 단일 출처로 삼는다.
    var streams = ['!bookTicker'];
    state.universe.forEach(function (s) {
      streams.push(s.toLowerCase() + '@kline_' + CFG.INTERVAL);
    });

    var sock = new Binance.Socket({
      onstate: function (st) {
        $('conn').dataset.state = st;
        $('conn-label').textContent = st === 'open' ? '실시간' : '재연결 중';
      },
      onmessage: onStream,
    });
    sock.connect(streams);

    // kline 스트림 생사 판정. 8초 안에 한 프레임도 없으면 REST 폴백으로 전환한다.
    setTimeout(function () {
      state.klineWS = state.rx.kline > 0;
      if (!state.klineWS) setInterval(refreshBars, CFG.BAR_POLL_MS);
    }, 8000);
  }

  function onStream(stream, data) {
    if (data.e === 'bookTicker') { state.rx.book++; applyBook(data); return; }
    if (data.e === 'kline') { state.rx.kline++; applyKline(data.s, data.k); }
  }

  /* 호가 갱신 → 진행 중인 봉의 종가·고저를 실시간으로 끌어올린다.
   * 봉 자체는 REST로 늦게 갱신되더라도 지표가 즉시 반응하게 만드는 장치다. */
  function applyBook(b) {
    var bid = +b.b, ask = +b.a;
    if (!(bid > 0 && ask > 0)) return;
    var mid = (bid + ask) / 2;
    state.book[b.s] = { bid: bid, ask: ask, mid: mid };

    var arr = state.bars[b.s];
    if (!arr || !arr.length) return;
    var cur = arr[arr.length - 1];
    cur[4] = String(mid);                                   // close
    if (mid > +cur[2]) cur[2] = String(mid);                // high
    if (mid < +cur[3]) cur[3] = String(mid);                // low
  }

  /* 진행 중인 봉은 덮어쓰고, 새 봉이면 밀어 넣는다. */
  function applyKline(sym, k) {
    var arr = state.bars[sym];
    if (!arr || !arr.length) return;
    var row = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V, k.Q, '0'];
    var lastOpen = arr[arr.length - 1][0];

    if (k.t === lastOpen) {
      arr[arr.length - 1] = row;
    } else if (k.t > lastOpen) {
      arr.push(row);
      if (arr.length > CFG.BARS) arr.shift();
    }
  }

  /* ------------------------------------------------------------ REST 폴링 */

  /* kline WS가 죽은 환경용 봉 갱신. 마지막 3봉만 받아 꼬리를 잇는다
   * (200봉을 매번 다시 받으면 종목당 weight 2가 그대로 나가고 대역폭도 낭비다). */
  async function refreshBars() {
    var syms = state.universe;
    var idx = 0;

    async function worker() {
      while (idx < syms.length) {
        var sym = syms[idx++];
        try {
          var fresh = await Binance.klines(sym, CFG.INTERVAL, 3);
          var arr = state.bars[sym];
          if (!arr || !fresh) continue;
          for (var i = 0; i < fresh.length; i++) {
            var openT = fresh[i][0];
            var lastOpen = arr[arr.length - 1][0];
            if (openT === lastOpen) arr[arr.length - 1] = fresh[i];
            else if (openT > lastOpen) {
              arr.push(fresh[i]);
              if (arr.length > CFG.BARS) arr.shift();
            }
          }
        } catch (e) { /* 다음 주기에 다시 */ }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  }

  /* 24h 통계와 펀딩비. 둘 다 전 종목을 한 번에 주므로 호출당 weight가 싸다
   * (ticker/24hr 40 · premiumIndex 10). 해당 WS 스트림이 죽어 있어 REST로 받는다. */
  async function refreshTickers() {
    try {
      var ticks = await Binance.ticker24h();
      ticks.forEach(function (t) { state.tickers[t.symbol] = t; });
    } catch (e) { /* 다음 주기에 다시 */ }
  }

  async function refreshFunding() {
    try {
      var prem = await Binance.premiumIndex();
      prem.forEach(function (p) {
        state.marks[p.symbol] = {
          markPrice: +p.markPrice,
          fundingRate: +p.lastFundingRate,
          nextFundingTime: p.nextFundingTime,
        };
      });
    } catch (e) { /* 다음 주기에 다시 */ }
  }

  /* ---------------------------------------------------------------- OI 폴링 */

  /* 미결제약정은 WS 스트림이 없어 폴링해야 하는 유일한 팩터다.
   * 유니버스 전체를 돈다 — 일부만 받으면 나머지 종목의 OI 팩터가 항상 중립이 되어
   * 리플레이(전 종목 보유)와 라이브의 입력이 달라진다. */
  async function pollOI() {
    var targets = (state.feats.length ? state.feats : [])
      .slice(0, CFG.OI_POLL_TOP)
      .map(function (f) { return f.symbol; });

    if (!targets.length) targets = state.universe.slice(0, CFG.OI_POLL_TOP);

    var idx = 0;
    async function worker() {
      while (idx < targets.length) {
        var sym = targets[idx++];
        try {
          var hist = await Binance.openInterestHist(sym, '5m', 13);  // 1시간
          if (hist && hist.length >= 2) {
            var first = +hist[0].sumOpenInterest;
            var last = +hist[hist.length - 1].sumOpenInterest;
            if (first > 0) state.oi[sym] = { chgPct: (last / first - 1) * 100 };
          }
        } catch (e) { /* 개별 실패는 무시 — 다음 주기에 다시 받는다 */ }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    setWeight();
  }

  /* -------------------------------------------------------------- 스코어링 */

  function rescore() {
    var feats = [];
    for (var i = 0; i < state.universe.length; i++) {
      var sym = state.universe[i];
      var f = Score.buildFeatures(
        sym, state.bars[sym], state.tickers[sym],
        state.marks[sym], state.oi[sym], state.meta[sym]
      );
      if (f) feats.push(f);
    }
    Score.scoreUniverse(feats);
    feats.sort(function (a, b) { return b.score - a.score; });
    state.feats = feats;

    render();
    setWeight();
  }

  /* ------------------------------------------------------------------ 렌더 */

  function currentList() {
    var f = state.feats;
    var liquid = f.filter(function (x) { return x.qv24 >= CFG.MIN_QV_RECO; });

    switch (state.view) {
      // 검증된 축으로 정렬한다. 스코어 순위는 변동폭 예측에서 단순 ATR 정렬에
      // 오히려 밀렸으므로(리플레이 vs_atr) 기본값을 이쪽으로 둔다.
      case 'move':
        return liquid.filter(function (x) { return x.exp_move != null; })
          .sort(function (a, b) { return b.exp_move - a.exp_move; })
          .slice(0, CFG.TOP_N);
      case 'long':
        return liquid.filter(function (x) { return x.side === 'LONG'; })
          .sort(function (a, b) { return b.score_long - a.score_long; })
          .slice(0, CFG.TOP_N);
      case 'short':
        return liquid.filter(function (x) { return x.side === 'SHORT'; })
          .sort(function (a, b) { return b.score_short - a.score_short; })
          .slice(0, CFG.TOP_N);
      case 'funding':
        return liquid.filter(function (x) { return x.funding != null; })
          .sort(function (a, b) { return Math.abs(b.funding) - Math.abs(a.funding); })
          .slice(0, CFG.TOP_N);
      case 'oi':
        return liquid.filter(function (x) { return x.oi_chg != null; })
          .sort(function (a, b) { return Math.abs(b.oi_chg) - Math.abs(a.oi_chg); })
          .slice(0, CFG.TOP_N);
      default:
        return liquid.slice(0, CFG.TOP_N);
    }
  }

  /* 표시할 종목 순서. 값은 계속 갱신하되 순서는 REORDER_MS 주기로만 바꾼다.
   * 사용자가 읽는 중에 행이 튀어 오르내리는 것을 막는 것이 목적이다. */
  function displayList() {
    var now = Date.now();
    var byId = {};
    state.feats.forEach(function (f) { byId[f.symbol] = f; });

    var keep = state.order.view === state.view &&
      now - state.order.ts < CFG.REORDER_MS &&
      state.order.syms.length &&
      state.order.syms.every(function (s) { return byId[s]; });

    if (keep) {
      return state.order.syms.map(function (s) { return byId[s]; });
    }
    var list = currentList();
    state.order = {
      view: state.view, ts: now,
      syms: list.map(function (f) { return f.symbol; }),
    };
    return list;
  }

  function render() {
    var list = displayList();
    var rows = $('rows');
    var sk = $('skeleton');
    if (sk) sk.remove();

    if (!list.length) {
      rows.innerHTML = '<div class="skeleton">조건을 만족하는 종목이 없습니다.</div>';
      state.rowEls.clear();
      return;
    }

    var seen = new Set();
    list.forEach(function (f, i) {
      seen.add(f.symbol);
      var el = state.rowEls.get(f.symbol);
      if (!el) {
        el = buildRow();
        state.rowEls.set(f.symbol, el);
      }
      updateRow(el, f, i + 1);
      // 이미 제자리에 있으면 DOM을 건드리지 않는다. appendChild는 항상
      // 제거+삽입이라 매번 부르면 스크롤 앵커가 매번 깨진다.
      if (rows.children[i] !== el) {
        rows.insertBefore(el, rows.children[i] || null);
      }
    });

    // 목록에서 빠진 행 제거
    state.rowEls.forEach(function (el, sym) {
      if (!seen.has(sym)) { el.remove(); state.rowEls.delete(sym); }
    });

    renderMarquees();
    var viewLabel = { move: '예상 변동폭 큰 순', reco: '스코어 순', long: '롱 편향',
                      short: '숏 편향', funding: '펀딩 극단', oi: 'OI 급증' }[state.view] || '';
    setMeta(state.feats.length + '종목 스캔 · ' + viewLabel + ' · 노출 기준 24h 거래대금 $' +
      (CFG.MIN_QV_RECO / 1e6) + 'M+');
    var path = state.klineWS === null ? '경로 판정 중'
      : (state.klineWS ? '봉 WS 수신' : '봉 REST ' + (CFG.BAR_POLL_MS / 1000) + '초 폴백');
    $('foot-scan').textContent =
      '유니버스 ' + state.universe.length + '종목 · ' + CFG.INTERVAL + ' 봉 ' + CFG.BARS + '개 · ' +
      (CFG.RESCORE_MS / 1000) + '초마다 재계산 · 가격 !bookTicker · ' + path;
  }

  function buildRow() {
    var el = document.createElement('div');
    el.className = 'row';
    el.innerHTML =
      '<span class="c-rank"></span>' +
      '<span class="c-name"><span class="sym"></span><span class="side-pill"></span></span>' +
      '<span class="c-price"></span>' +
      '<span class="c-move"></span>' +
      '<span class="c-chg"></span>' +
      '<span class="c-fund"></span>' +
      '<span class="c-score"><span class="mark"></span><span class="tags"></span></span>';
    return el;
  }

  function updateRow(el, f, rank) {
    el.dataset.side = f.side;
    el.querySelector('.c-rank').textContent = rank;
    el.querySelector('.sym').textContent = f.base;

    var pill = el.querySelector('.side-pill');
    pill.dataset.side = f.side;
    pill.textContent = f.side;
    pill.title = '스코어가 기운 방향입니다. 방향 예측력은 검증되지 않았습니다.';

    // 가격 + 방향 플래시
    var priceEl = el.querySelector('.c-price');
    var txt = fmtPrice(f.price, f.pricePrecision);
    if (priceEl.textContent !== txt) {
      var prev = state.lastPrice[f.symbol];
      priceEl.textContent = txt;
      priceEl.classList.remove('f-up', 'f-down');
      if (prev != null && f.price !== prev) {
        void priceEl.offsetWidth;                       // 애니메이션 재시작 강제
        priceEl.classList.add(f.price > prev ? 'f-up' : 'f-down');
      }
      state.lastPrice[f.symbol] = f.price;
    }

    // 예상 변동폭 — 실측 보정된 수치라 가장 크게 보여준다
    var moveEl = el.querySelector('.c-move');
    if (f.exp_move == null) {
      moveEl.textContent = '—';
      moveEl.className = 'c-move';
    } else {
      moveEl.textContent = '±' + f.exp_move.toFixed(1) + '%';
      moveEl.className = 'c-move' + (f.exp_move >= 4 ? ' wide' : '');
      moveEl.title = 'ATR ' + (f.atr_pct == null ? '—' : f.atr_pct.toFixed(2) + '%') +
        ' 기반 4시간 예상 변동폭 (실측 보정 K=' + CFG.MOVE_K + ')';
    }

    var chgEl = el.querySelector('.c-chg');
    var c = f.ret_24h;
    chgEl.textContent = c == null ? '—' : Score.fmtPct(c);
    chgEl.className = 'c-chg ' + (c == null ? '' : (c >= 0 ? 'up' : 'down'));

    var fundEl = el.querySelector('.c-fund');
    if (f.funding == null) {
      fundEl.textContent = '—';
      fundEl.className = 'c-fund';
    } else {
      fundEl.textContent = (f.funding >= 0 ? '+' : '') + (f.funding * 100).toFixed(3) + '%';
      fundEl.className = 'c-fund ' + (f.funding >= 0 ? 'up' : 'down');
    }

    var markEl = el.querySelector('.mark');
    markEl.dataset.m = f.mark;          // 스타일용 내부 키
    markEl.textContent = Score.markLabel(f.mark);
    markEl.title = Score.MARK_DESC[f.mark] || '';

    var tags = el.querySelector('.tags');
    var html = '';
    (f.tags || []).forEach(function (t) {
      var cls = 'tag';
      if (t === '스퀴즈 임박' || t.indexOf('거래량') === 0) cls += ' hot';
      if (t === '과열' || t === '과냉' || t === '급등후' || t === '펀딩과밀' || t === '신규상장') cls += ' warn';
      html += '<span class="' + cls + '">' + esc(t) + '</span>';
    });
    if (tags.innerHTML !== html) tags.innerHTML = html;
  }

  function renderMarquees() {
    // 매 렌더마다 innerHTML을 갈아엎으면 CSS 애니메이션이 리셋되어
    // 마퀴가 흐르지 않고 제자리에서 튄다.
    if (Date.now() - state.marqueeTs < CFG.MARQUEE_MS) return;
    state.marqueeTs = Date.now();

    // 상단: 거래대금 상위 24종목 실시간 시세
    var top = state.feats.slice(0, 24);
    $('track-top').innerHTML = marqueeHTML(top) + marqueeHTML(top);

    // 하단: 추천에는 못 들었지만 점수가 붙은 관심 종목
    var watch = state.feats.filter(function (x) { return x.qv24 >= CFG.MIN_QV_RECO; })
      .slice(CFG.TOP_N, CFG.TOP_N + 16);
    $('track-bottom').innerHTML = watchHTML(watch) + watchHTML(watch);
  }

  function marqueeHTML(list) {
    return list.map(function (f) {
      var c = f.ret_24h || 0;
      return '<span class="mq-item"><b>' + esc(f.base) + '</b>' +
        fmtPrice(f.price, f.pricePrecision) +
        ' <span class="' + (c >= 0 ? 'up' : 'down') + '">' + Score.fmtPct(c) + '</span></span>';
    }).join('');
  }

  function watchHTML(list) {
    return list.map(function (f) {
      return '<span class="mq-item"><b>' + esc(f.base) + '</b>' +
        f.mark + ' ' + f.side + ' ' + f.score.toFixed(0) + '</span>';
    }).join('');
  }

  /* ------------------------------------------------------------------ 유틸 */

  function fmtPrice(p, precision) {
    if (p == null) return '—';
    var d = precision != null ? Math.min(precision, 8) : 4;
    if (p >= 1000) d = Math.min(d, 1);
    else if (p >= 1) d = Math.min(d, 4);
    return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function setMeta(t) { $('board-meta').textContent = t; }

  function setWeight() {
    $('weight').textContent = 'W ' + Binance.usedWeight() + '/2400';
  }

  function showError(e) {
    var geo = e && e.geoBlocked;
    $('rows').innerHTML = '<div class="error"><b>' +
      (geo ? '이 지역에서는 바이낸스 API에 접근할 수 없습니다 (HTTP 451)'
           : '데이터를 불러오지 못했습니다') + '</b>' +
      (geo ? '바이낸스가 일부 국가의 IP를 차단합니다. VPN 없이 접속 가능한 지역에서 다시 시도해 주세요.'
           : esc(e && e.message ? e.message : String(e))) + '</div>';
    $('conn').dataset.state = 'closed';
    $('conn-label').textContent = '오류';
  }

  function tickClock() {
    var kst = new Date(Date.now() + (new Date().getTimezoneOffset() * 60000) + 9 * 3600000);
    $('clock').textContent = kst.toTimeString().slice(0, 8);
  }

  /* ------------------------------------------------------------------ 시작 */

  $('tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('.tab');
    if (!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('is-on', t === b);
    });
    state.view = b.dataset.view;
    state.order = { view: null, syms: [], ts: 0 };   // 탭 전환은 즉시 재정렬
    state.rowEls.forEach(function (el) { el.remove(); });
    state.rowEls.clear();
    if (state.booted) render();
  });

  tickClock();
  setInterval(tickClock, 1000);
  boot();
})();
