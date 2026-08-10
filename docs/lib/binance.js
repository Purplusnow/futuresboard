/* 바이낸스 USDT-M 선물 클라이언트 — REST 부트스트랩 + WebSocket 실시간 구독
 *
 * COIN BOARD(업비트)와 정반대 구조다. 업비트는 Origin 헤더가 붙으면 캔들 API가
 * 즉시 429라 서버(Actions)에서 받아야 했지만, 바이낸스 fapi는
 *   access-control-allow-origin: *
 * 로 완전 개방이라 브라우저가 직접 친다. 게다가 rate limit이 방문자 IP당
 * 부과되므로 트래픽이 늘어도 한도가 분산된다 — 정적 페이지에 최적이다.
 *
 * 반대로 GitHub Actions 러너는 미국 IP라 fapi가 451로 차단될 수 있다.
 * 그래서 이 프로젝트는 Actions를 쓰지 않는다(백테스트가 필요해지면
 * 지역 차단이 없는 data.binance.vision 덤프를 쓴다).
 *
 * 예산: IP당 2400 weight/분.
 *   exchangeInfo 1 · ticker/24hr 전체 40 · premiumIndex 전체 10 · klines(≤500봉) 2
 * 부트 이후 시세·펀딩은 전부 WS로 받으므로 정상 운영 중 REST 소비는 OI 폴링뿐이다.
 */
(function (global) {
  'use strict';

  var FAPI = 'https://fapi.binance.com';
  var WSBASE = 'wss://fstream.binance.com/stream';

  /* 사용 weight 집계.
   *
   * 서버는 x-mbx-used-weight-1m 헤더로 알려주지만, 바이낸스 CORS 응답에
   * Access-Control-Expose-Headers가 없어 브라우저 JS는 이 헤더를 읽을 수 없다
   * (fetch가 null을 준다). 그래서 호출한 엔드포인트의 공표 weight를 직접 집계한다.
   * 헤더가 언젠가 노출되면 그 값을 우선한다. */
  var ledger = [];        // [{ t, w }] 최근 60초
  var headerWeight = null;

  function charge(w) {
    var now = Date.now();
    ledger.push({ t: now, w: w });
    while (ledger.length && now - ledger[0].t > 60000) ledger.shift();
  }

  function usedWeight() {
    if (headerWeight != null) return headerWeight;
    var now = Date.now(), sum = 0;
    for (var i = 0; i < ledger.length; i++) {
      if (now - ledger[i].t <= 60000) sum += ledger[i].w;
    }
    return sum;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------------------------------------------------------------- REST */

  async function get(path, opts) {
    opts = opts || {};
    var retries = opts.retries == null ? 3 : opts.retries;
    var delay = 500;
    charge(opts.weight || 1);

    for (var attempt = 0; ; attempt++) {
      var res;
      try {
        res = await fetch(FAPI + path, { cache: 'no-store' });
      } catch (e) {
        // 네트워크 오류 / 지역 차단으로 연결 자체가 끊긴 경우
        if (attempt >= retries) throw new Error('network: ' + path);
        await sleep(delay); delay *= 2; continue;
      }

      var w = res.headers.get('x-mbx-used-weight-1m');
      if (w) headerWeight = parseInt(w, 10) || headerWeight;

      if (res.status === 429 || res.status === 418) {
        // 한도 초과. Retry-After를 존중한다(무시하면 IP 밴으로 승격된다).
        var wait = parseInt(res.headers.get('retry-after') || '0', 10) * 1000 || delay;
        if (attempt >= retries) throw new Error('rate limited: ' + path);
        await sleep(wait); delay *= 2; continue;
      }
      if (res.status === 451 || res.status === 403) {
        // 지역 차단. 재시도해도 의미 없으므로 즉시 올려보내 UI가 안내하게 한다.
        var err = new Error('geo-blocked');
        err.geoBlocked = true;
        throw err;
      }
      if (!res.ok) {
        if (attempt >= retries) throw new Error('HTTP ' + res.status + ': ' + path);
        await sleep(delay); delay *= 2; continue;
      }
      return res.json();
    }
  }

  /* 거래 중인 USDT 무기한(PERPETUAL) 종목만. 분기물·정산 예정 종목은 뺀다. */
  async function perpetualSymbols() {
    var info = await get('/fapi/v1/exchangeInfo', { weight: 1 });
    var out = [];
    for (var i = 0; i < info.symbols.length; i++) {
      var s = info.symbols[i];
      if (s.status !== 'TRADING') continue;
      if (s.contractType !== 'PERPETUAL') continue;
      if (s.quoteAsset !== 'USDT') continue;
      out.push({
        symbol: s.symbol,
        base: s.baseAsset,
        pricePrecision: s.pricePrecision,
        onboard: s.onboardDate || 0,
      });
    }
    return out;
  }

  function ticker24h() { return get('/fapi/v1/ticker/24hr', { weight: 40 }); }
  function premiumIndex() { return get('/fapi/v1/premiumIndex', { weight: 10 }); }

  function klines(symbol, interval, limit) {                        // weight 2 (≤500)
    return get('/fapi/v1/klines?symbol=' + symbol +
      '&interval=' + interval + '&limit=' + (limit || 200),
      { weight: (limit || 200) >= 500 ? 5 : 2 });
  }

  /* 미결제약정 이력. WS 스트림이 없어 폴링해야 하는 유일한 선물 팩터다.
   * period 5m · limit N. /futures/data 는 별도 쿼터를 쓴다. */
  function openInterestHist(symbol, period, limit) {
    return get('/futures/data/openInterestHist?symbol=' + symbol +
      '&period=' + (period || '5m') + '&limit=' + (limit || 13), { weight: 1 });
  }

  /* 여러 종목의 캔들을 동시성 제한을 두고 받는다. 680종목을 한 번에 쏘면
   * 브라우저 커넥션 풀이 막히고 weight도 순간적으로 터진다. */
  async function klinesBatch(symbols, interval, limit, concurrency, onProgress) {
    var out = {};
    var idx = 0;
    var done = 0;
    concurrency = concurrency || 8;

    async function worker() {
      while (idx < symbols.length) {
        var i = idx++;
        var sym = symbols[i];
        try {
          out[sym] = await klines(sym, interval, limit);
        } catch (e) {
          if (e.geoBlocked) throw e;   // 지역 차단은 전체 중단
          out[sym] = null;             // 개별 실패는 무시하고 계속
        }
        done++;
        if (onProgress) onProgress(done, symbols.length);
      }
    }

    var workers = [];
    for (var w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  /* ----------------------------------------------------------- WebSocket */

  /* 결합 스트림 소켓. 끊기면 지수 백오프로 재연결하고 구독을 복원한다.
   * 한 연결당 스트림 1024개, 수신 메시지 5건/초 제한이 있어
   * 구독은 청크로 나눠 간격을 두고 보낸다. */
  function Socket(handlers) {
    this.handlers = handlers || {};
    this.streams = [];
    this.ws = null;
    this.backoff = 1000;
    this.closedByUser = false;
    this.reqId = 1;
  }

  Socket.prototype.connect = function (streams) {
    var self = this;
    this.streams = streams.slice();
    this.closedByUser = false;

    // 최초 연결은 URL에 스트림을 실어 보낸다(핸드셰이크 직후 바로 수신 시작).
    // URL이 과도하게 길어지지 않도록 앞 200개만 싣고 나머지는 SUBSCRIBE로.
    var head = this.streams.slice(0, 200);
    var tail = this.streams.slice(200);

    var ws = new WebSocket(WSBASE + '?streams=' + head.join('/'));
    this.ws = ws;

    ws.onopen = function () {
      self.backoff = 1000;
      if (self.handlers.onstate) self.handlers.onstate('open');
      if (tail.length) self.subscribe(tail);
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg.data) return;                    // 구독 응답(result:null) 등
      if (self.handlers.onmessage) self.handlers.onmessage(msg.stream, msg.data);
    };

    ws.onclose = function () {
      if (self.handlers.onstate) self.handlers.onstate('closed');
      if (self.closedByUser) return;
      setTimeout(function () { self.connect(self.streams); }, self.backoff);
      self.backoff = Math.min(self.backoff * 2, 30000);
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };

  /* 초당 5건 제한을 지키며 청크 구독. */
  Socket.prototype.subscribe = async function (streams) {
    for (var i = 0; i < streams.length; i += 100) {
      if (!this.ws || this.ws.readyState !== 1) return;
      var chunk = streams.slice(i, i + 100);
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIBE', params: chunk, id: this.reqId++,
      }));
      await sleep(300);
    }
  };

  Socket.prototype.close = function () {
    this.closedByUser = true;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  };

  global.Binance = {
    perpetualSymbols: perpetualSymbols,
    ticker24h: ticker24h,
    premiumIndex: premiumIndex,
    klines: klines,
    klinesBatch: klinesBatch,
    openInterestHist: openInterestHist,
    Socket: Socket,
    usedWeight: usedWeight,
  };
})(window);
