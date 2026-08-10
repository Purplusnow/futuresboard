/* 전진 검증 원장 — "추천대로 매매했다면 실제로 어떻게 됐는가"를 비용까지 넣어 누적한다.
 *
 * ── 왜 리플레이로 부족한가 ────────────────────────────────────────────────
 * tools/replay.mjs 는 과거 구간을 되돌린다. 아무리 누수를 막아도 "과거에 맞춰
 * 튜닝했을 수 있다"는 의심을 구조적으로 벗지 못한다. 그래서 모델을 **동결**하고,
 * 동결 이후에 생긴 데이터로만 채워 나가는 원장을 따로 둔다. 데이터가 모델보다
 * 나중에 존재하므로 과최적화가 원천적으로 불가능하다.
 *
 * 각 기록에 모델 커밋 SHA와 생성 시각을 남긴다. 모델이 데이터보다 먼저였음을
 * 제3자가 확인할 수 있어야 "전진 검증"이라 부를 수 있다.
 *
 * ── 왜 GitHub Actions에서 도는가 ──────────────────────────────────────────
 * 실측 결과 Actions 러너(US)는 fapi가 451로 막힌다. 반면 data.binance.vision
 * 덤프는 200이다. 그래서 신호 생성도 평가도 전부 덤프(T+1)로 한다.
 *
 * ── 비용을 반드시 넣는다 ──────────────────────────────────────────────────
 * 지금까지의 모든 측정은 총수익(gross)이었다. 선물은 왕복 수수료·슬리피지·펀딩을
 * 합치면 0.15% 안팎이 나가는데, 측정된 방향 우위는 그보다 작았다. 비용을 빼지 않은
 * 수익률은 검증이 아니라 착시다.
 *
 * 사용법: node tools/paper.mjs --from 2026-08-10 --to 2026-08-10
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
globalThis.window = globalThis;
for (const f of ['docs/config.js', 'docs/lib/indicators.js', 'docs/lib/score.js', 'docs/lib/alerts.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const LEDGER = path.join(ROOT, arg('ledger', 'docs/data/ledger.json'));
const CACHE = path.join(ROOT, arg('cache', '.cache'));
const STEP = +arg('step', 12);            // 신호 생성 간격(봉). 12 = 1시간
const HOLD = +arg('hold', 48);            // 보유 기간(봉). 48 = 4시간
const BAR_MS = 5 * 60 * 1000;
const BARS_24H = 288;
const WARMUP = Math.max(CFG.BARS, BARS_24H) + 2;

/* ── 비용 모델 ─────────────────────────────────────────────────────────────
 * 바이낸스 USDT-M 선물 표준(VIP0) 테이커 0.05%. 진입·청산 모두 테이커로 가정한다.
 * 지정가로 메이커를 노리는 전략도 가능하지만 체결 보장이 없어 검증이 흐려진다.
 * 슬리피지는 노출 기준($30M+)의 유동성에서 보수적으로 잡은 값이다.
 * 실제와 다를 수 있으므로 원장에 값을 함께 남겨 나중에 재계산할 수 있게 한다. */
const COST = {
  taker_fee: 0.05,        // % (편도)
  slippage: 0.02,         // % (편도)
  get round_trip() { return (this.taker_fee + this.slippage) * 2; },   // 0.14%
};

/* ── 전략 ──────────────────────────────────────────────────────────────────
 * 하나만 굴리면 "그 전략이 나빴다"는 것 외에 배울 게 없다. 대조군과 반대매매를
 * 함께 굴려야 결과를 해석할 수 있다. 전부 같은 데이터 한 번으로 계산되므로 비용은 같다. */
const STRATEGIES = [
  {
    id: 'model_dir',
    label: '모델 방향 (스코어 상위 14)',
    note: '전광판이 고른 종목을 스코어가 기운 방향으로',
    pick: (feats) => board(feats).map((f) => ({ f, side: f.side })),
  },
  {
    id: 'model_fade',
    label: '모델 반대매매',
    note: '같은 종목을 반대 방향으로 — 모델이 체계적으로 틀렸는지 확인',
    pick: (feats) => board(feats).map((f) => ({ f, side: f.side === 'LONG' ? 'SHORT' : 'LONG' })),
  },
  {
    id: 'mark_top',
    label: '◎ 등급만',
    note: '가장 확신이 높다고 표시한 것만 — 등급이 의미가 있는지 확인',
    pick: (feats) => board(feats).filter((f) => f.mark === '◎').map((f) => ({ f, side: f.side })),
  },
  {
    id: 'alert_event',
    label: '사건형 알림 (강)',
    note: '거래량 폭증·돌파·급변 강도2. 방향은 직전 15분 움직임을 따른다',
    pick: (feats) => eligible(feats)
      .filter((f) => Alerts.evaluate(f).some(
        (h) => h.level >= 2 && ['vol_spike', 'breakout', 'impulse'].includes(h.id)))
      .map((f) => ({ f, side: (f.ret_15m || 0) >= 0 ? 'LONG' : 'SHORT' })),
  },
  {
    id: 'control_random',
    label: '대조군 (자격 풀 롱)',
    note: '노출 기준을 통과한 종목 전부를 롱 — 시장 방향 그 자체',
    pick: (feats) => eligible(feats).map((f) => ({ f, side: 'LONG' })),
  },
];

const eligible = (feats) => feats.filter((f) => f.qv24 >= CFG.MIN_QV_RECO);
const board = (feats) => eligible(feats).sort((a, b) => b.score - a.score).slice(0, CFG.TOP_N);

/* ---------------------------------------------------------------- 데이터 */

const files = fs.readdirSync(CACHE).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const data = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
  if (!d.klines || d.klines.length < WARMUP + HOLD + 5) continue;
  const idx = new Map();
  d.klines.forEach((k, i) => idx.set(k[0], i));
  const oiMap = new Map();
  for (const [t, v] of d.oi || []) oiMap.set(t, v);
  data[d.symbol] = { ...d, idx, oiMap };
}
const symbols = Object.keys(data);
console.error(`캐시 ${symbols.length}종목`);

function fundingAt(sym, t) {
  const f = data[sym].funding;
  if (!f || !f.length) return null;
  let lo = 0, hi = f.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (f[m][0] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : f[ans][1];
}
/* 보유 구간에 걸린 펀딩 정산의 합. 롱은 펀딩이 양수면 지불한다. */
function fundingCost(sym, t0, t1, side) {
  const f = data[sym].funding || [];
  let paid = 0;
  for (const [ts, rate] of f) {
    if (ts > t0 && ts <= t1) paid += (side === 'LONG' ? rate : -rate) * 100;
  }
  return paid;   // % (양수 = 지불)
}
function oiChgAt(sym, t) {
  const m = data[sym].oiMap;
  const a = m.get(t - 12 * BAR_MS), b = m.get(t);
  return (a > 0 && b > 0) ? { chgPct: (b / a - 1) * 100 } : null;
}
function tickerAt(sym, i) {
  const kl = data[sym].klines;
  if (i < BARS_24H) return null;
  let qv = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) qv += +kl[j][7];
  const past = +kl[i - BARS_24H][4], now = +kl[i][4];
  return { quoteVolume: qv, priceChangePercent: past ? (now / past - 1) * 100 : 0 };
}

/* ------------------------------------------------------------- 시뮬레이션 */

function tradesAt(t) {
  const feats = [];
  const pool = [];
  for (const sym of symbols) {
    const D = data[sym];
    const i = D.idx.get(t);
    if (i == null || i < WARMUP) continue;
    const tick = tickerAt(sym, i);
    if (!tick || tick.quoteVolume < CFG.MIN_QV_UNIVERSE) continue;
    pool.push({ sym, i, qv: tick.quoteVolume, tick });
  }
  if (pool.length < 20) return null;
  pool.sort((a, b) => b.qv - a.qv);

  for (const u of pool.slice(0, CFG.UNIVERSE_SIZE)) {
    const bars = data[u.sym].klines.slice(u.i - CFG.BARS + 1, u.i + 1);
    if (bars.length < CFG.BARS || bars[bars.length - 1][0] - bars[0][0] !== (CFG.BARS - 1) * BAR_MS) continue;
    const f = Score.buildFeatures(u.sym, bars, u.tick,
      { fundingRate: fundingAt(u.sym, t), nextFundingTime: null },
      oiChgAt(u.sym, t), { base: u.sym.replace(/USDT$/, ''), pricePrecision: 4, onboard: 0 });
    if (f) { f._i = u.i; feats.push(f); }
  }
  if (feats.length < 20) return null;
  Score.scoreUniverse(feats);

  const out = {};
  for (const st of STRATEGIES) {
    const picks = st.pick(feats);
    const trades = [];
    for (const p of picks) {
      const kl = data[p.f.symbol].klines;
      const i = p.f._i;
      if (i + 1 >= kl.length || i + HOLD >= kl.length) continue;
      if (kl[i + HOLD][0] - kl[i][0] !== HOLD * BAR_MS) continue;   // 상장 공백 방어

      const entry = +kl[i + 1][1];          // 다음 봉 시가 — 같은 봉에서는 살 수 없다
      const exit = +kl[i + HOLD][4];
      if (!(entry > 0) || !(exit > 0)) continue;

      const gross = (exit / entry - 1) * 100 * (p.side === 'SHORT' ? -1 : 1);
      const fund = fundingCost(p.f.symbol, kl[i + 1][0], kl[i + HOLD][6], p.side);
      const net = gross - COST.round_trip - fund;

      trades.push({
        sym: p.f.symbol, side: p.side, mark: p.f.mark,
        gross: r4(gross), fee: COST.round_trip, funding: r4(fund), net: r4(net),
      });
    }
    if (trades.length) out[st.id] = trades;
  }
  return out;
}

/* ------------------------------------------------------------------ 실행 */

const from = arg('from');
const to = arg('to', from);
if (!from) { console.error('--from YYYY-MM-DD 가 필요합니다'); process.exit(1); }
const t0 = Date.parse(from + 'T00:00:00Z');
const t1 = Date.parse(to + 'T23:59:59Z');

let sha = 'unknown';
try { sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (e) {}

const allTimes = new Set();
for (const s of symbols) for (const k of data[s].klines) allTimes.add(k[0]);
const times = [...allTimes].sort((a, b) => a - b)
  .filter((t) => t >= t0 && t <= t1 && (t / BAR_MS) % STEP === 0);
console.error(`신호 시각 ${times.length}개 (${from} ~ ${to}, ${STEP * 5}분 간격, 보유 ${HOLD * 5 / 60}시간)`);

const ledger = fs.existsSync(LEDGER)
  ? JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
  : { version: 1, cost: COST, hold_hours: HOLD * 5 / 60, step_min: STEP * 5,
      freeze_date: arg('freeze', '2026-08-11'),
      strategies: STRATEGIES.map((s) => ({ id: s.id, label: s.label, note: s.note })),
      days: {} };

let added = 0;
const touched = new Set();     // 이번 실행에서 다시 계산한 날
for (const t of times) {
  const res = tradesAt(t);
  if (!res) continue;
  const day = new Date(t).toISOString().slice(0, 10);
  // 동결일 이전은 백테스트, 이후는 전진 검증. 화면에서 절대 합치지 않는다.
  const mode = day < (ledger.freeze_date || '2026-08-11') ? 'backtest' : 'forward';
  if (!touched.has(day)) {
    // 재처리는 덮어쓴다. 기존 누계에 더하면 재시도할 때마다 그날이 두 배가 된다.
    touched.add(day);
    ledger.days[day] = { model_sha: sha, mode: mode, strat: {} };
  }
  const d = ledger.days[day];
  for (const [sid, trades] of Object.entries(res)) {
    const acc = (d.strat[sid] = d.strat[sid] || { n: 0, gross: 0, net: 0, wins: 0 });
    for (const tr of trades) {
      acc.n++; acc.gross += tr.gross; acc.net += tr.net; if (tr.net > 0) acc.wins++;
    }
  }
  added++;
}
// 일별 평균으로 정규화 — 전략마다 종목 수가 달라 합계로는 비교가 안 된다
for (const day of Object.keys(ledger.days)) {
  for (const acc of Object.values(ledger.days[day].strat)) {
    acc.avg_gross = r4(acc.gross / acc.n);
    acc.avg_net = r4(acc.net / acc.n);
    acc.win_rate = r4(acc.wins / acc.n);
    acc.gross = r4(acc.gross); acc.net = r4(acc.net);
  }
}
if (added === 0) {
  console.error('새로 기록할 신호가 없습니다 — 원장을 건드리지 않습니다.');
  console.error('(덤프가 아직 안 올라왔거나 대상 날짜에 데이터가 없습니다)');
  process.exit(0);
}

ledger.updated_at = new Date(+arg('now', Date.now())).toISOString().slice(0, 19) + 'Z';
ledger.cost = COST;

fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
console.error(`시각 ${added}개 기록 (${[...touched].join(', ')}) → ${path.relative(ROOT, LEDGER)}`);

/* 요약 출력 */
const days = Object.keys(ledger.days).sort();
console.log(`\n원장 ${days.length}일 (${days[0]} ~ ${days[days.length - 1]})`);
console.log(`비용: 왕복 ${COST.round_trip.toFixed(2)}% (테이커 ${COST.taker_fee}%×2 + 슬리피지 ${COST.slippage}%×2) + 펀딩 실비\n`);
console.log('전략                          매매수   평균총수익   평균순수익   승률    누적순수익');
console.log('─'.repeat(84));
for (const st of STRATEGIES) {
  let n = 0, g = 0, net = 0, w = 0;
  for (const day of days) {
    const a = ledger.days[day].strat[st.id];
    if (!a) continue;
    n += a.n; g += a.gross; net += a.net; w += a.wins;
  }
  if (!n) continue;
  console.log(`${st.label.padEnd(26)} ${String(n).padStart(6)}   ${pc(g / n)}   ${pc(net / n)}   ` +
    `${(w / n * 100).toFixed(1)}%   ${pc(net, 1)}`);
}

function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function pc(v, w) { return ((v >= 0 ? '+' : '') + v.toFixed(w === 1 ? 1 : 3) + '%').padStart(10); }
