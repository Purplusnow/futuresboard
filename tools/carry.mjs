/* 펀딩 캐리 — 방향을 맞히지 않고 '수수료를 받는' 쪽에 서는 전략.
 *
 * 지금까지 시도한 것들은 전부 가격 방향을 맞히려 했고 전부 실패했다. 이건 다르다.
 * 펀딩비는 예측이 아니라 계약상 확정되는 현금흐름이다. 펀딩이 높은 종목(롱이 과밀)을
 * 숏하면 8시간마다 그 펀딩을 '받는다'. 가격이 제자리면 그대로 수익이다.
 *
 * 진짜 캐리는 현물 롱 + 선물 숏으로 가격 위험을 완전히 지우지만, 이 프로젝트는
 * 선물 데이터만 있으므로 대신 **횡단면 중립**으로 근사한다.
 *   펀딩 상위 K개를 숏 + 펀딩 하위 K개를 롱, 같은 금액.
 * 시장 전체가 오르내리는 부분은 상쇄되고 펀딩 차이만 남는 것을 노린다.
 *
 * 공짜가 아니다. 다리가 둘이라 비용도 두 배(왕복 0.28%)이고, 펀딩이 높다는 것은
 * 그 종목이 이미 과열됐다는 뜻이라 가격이 반대로 튈 수 있다. 그게 이 거래의 위험이다.
 *
 * 사용법: node tools/carry.mjs [--k 8] [--holds 1d,3d,7d]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
globalThis.window = globalThis;
for (const f of ['docs/config.js', 'docs/lib/indicators.js', 'docs/lib/score.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const CACHE = path.join(ROOT, '.cache');
const BAR_MS = 5 * 60 * 1000;
const BARS_24H = 288;
const WARMUP = BARS_24H + 2;          // 지표가 필요 없으므로 24h 거래대금만 있으면 된다
const K = +arg('k', 8);               // 각 방향 종목 수
const STEP = +arg('step', 96);        // 신호 간격 8시간 = 펀딩 정산 주기
const COST_LEG = 0.14;                // 다리당 왕복 (수수료+슬리피지)

const HOLDS = [['8h', 96], ['1d', 288], ['2d', 576], ['3d', 864], ['7d', 2016]];
const MAX_H = Math.max(...HOLDS.map((h) => h[1]));

/* ---------------------------------------------------------------- 데이터 */

const data = {};
for (const fn of fs.readdirSync(CACHE).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE, fn), 'utf8'));
  if (!d.klines || d.klines.length < WARMUP + MAX_H + 5) continue;
  if (!d.funding || !d.funding.length) continue;      // 펀딩 없으면 이 실험의 대상이 아니다
  const idx = new Map();
  d.klines.forEach((k, i) => idx.set(k[0], i));
  data[d.symbol] = { ...d, idx };
}
const symbols = Object.keys(data);
console.error(`캐시 ${symbols.length}종목 (펀딩 이력 보유) · 각 방향 ${K}종목`);

const fundingAt = (sym, t) => {
  const f = data[sym].funding;
  let lo = 0, hi = f.length - 1, a = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (f[m][0] <= t) { a = m; lo = m + 1; } else hi = m - 1; }
  return a < 0 ? null : f[a][1];
};
const fundingPaid = (sym, t0, t1, side) => {
  let paid = 0;
  for (const [ts, rate] of data[sym].funding) {
    if (ts > t0 && ts <= t1) paid += (side === 'LONG' ? rate : -rate) * 100;
  }
  return paid;   // 양수 = 지불, 음수 = 수취
};
const qv24 = (sym, i) => {
  const kl = data[sym].klines;
  if (i < BARS_24H) return null;
  let q = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) q += +kl[j][7];
  return q;
};

function legRet(sym, i, hold, side) {
  const kl = data[sym].klines;
  if (i + 1 >= kl.length || i + hold >= kl.length) return null;
  if (kl[i + hold][0] - kl[i][0] !== hold * BAR_MS) return null;
  const entry = +kl[i + 1][1], exit = +kl[i + hold][4];
  if (!(entry > 0) || !(exit > 0)) return null;
  const price = (exit / entry - 1) * 100 * (side === 'SHORT' ? -1 : 1);
  const fund = fundingPaid(sym, kl[i + 1][0], kl[i + hold][6], side);
  return { price, fund, net: price - fund - COST_LEG };
}

/* ------------------------------------------------------------- 시뮬레이션 */

const allT = new Set();
for (const s of symbols) for (const k of data[s].klines) allT.add(k[0]);
const times = [...allT].sort((a, b) => a - b);
const evalTimes = times.filter((t, _, a) =>
  t >= a[0] + WARMUP * BAR_MS && t <= a[a.length - 1] - MAX_H * BAR_MS && (t / BAR_MS) % STEP === 0);
console.error(`신호 시각 ${evalTimes.length}개 (${STEP * 5 / 60}시간 간격)`);

const R = {};                       // hold -> [{t, net, price, fund}]
for (const [hk] of HOLDS) R[hk] = [];

for (const t of evalTimes) {
  const cand = [];
  for (const sym of symbols) {
    const i = data[sym].idx.get(t);
    if (i == null || i < WARMUP) continue;
    const q = qv24(sym, i);
    if (!q || q < CFG.MIN_QV_RECO) continue;      // 노출 기준과 동일한 유동성 필터
    const fr = fundingAt(sym, t);
    if (fr == null) continue;
    cand.push({ sym, i, fr });
  }
  if (cand.length < K * 3) continue;             // 양끝을 뽑을 만큼 넓어야 한다

  cand.sort((a, b) => b.fr - a.fr);
  const shorts = cand.slice(0, K);               // 펀딩 최고 → 숏(펀딩 수취)
  const longs = cand.slice(-K);                  // 펀딩 최저 → 롱

  for (const [hk, hold] of HOLDS) {
    const legs = [];
    for (const s of shorts) { const r = legRet(s.sym, s.i, hold, 'SHORT'); if (r) legs.push(r); }
    for (const l of longs) { const r = legRet(l.sym, l.i, hold, 'LONG'); if (r) legs.push(r); }
    if (legs.length < K) continue;
    const avg = (sel) => legs.reduce((a, x) => a + sel(x), 0) / legs.length;
    R[hk].push({ t, net: avg((x) => x.net), price: avg((x) => x.price), fund: avg((x) => x.fund) });
  }
}

/* ------------------------------------------------------------- 집계 */

const mid = evalTimes[Math.floor(evalTimes.length / 2)];
const pc = (v, d = 3) => v == null ? '     —' : ((v >= 0 ? '+' : '') + v.toFixed(d) + '%').padStart(9);

console.log(`\n펀딩 캐리 (상위 ${K} 숏 + 하위 ${K} 롱, 다리당 왕복 ${COST_LEG}%)`);
console.log('보유    회차   유효n   가격손익   펀딩수취    순수익    승률    t      전반/후반');
for (const [hk, hold] of HOLDS) {
  const rows = R[hk];
  if (rows.length < 20) continue;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const nets = rows.map((r) => r.net);
  const m = mean(nets);
  const sd = Math.sqrt(nets.reduce((a, b) => a + (b - m) ** 2, 0) / (nets.length - 1));
  const nEff = rows.length / Math.max(1, hold / STEP);
  const h1 = rows.filter((r) => r.t < mid).map((r) => r.net);
  const h2 = rows.filter((r) => r.t >= mid).map((r) => r.net);
  const t = m / (sd / Math.sqrt(nEff));
  const ok = m > 0 && Math.abs(t) >= 2 && mean(h1) > 0 && mean(h2) > 0;
  console.log(`${hk.padEnd(6)} ${String(rows.length).padStart(5)} ${String(Math.round(nEff)).padStart(6)} ` +
    `${pc(mean(rows.map((r) => r.price)))} ${pc(-mean(rows.map((r) => r.fund)))} ${pc(m)}  ` +
    `${(nets.filter((v) => v > 0).length / nets.length * 100).toFixed(1)}%  ${t.toFixed(1).padStart(5)}  ` +
    `${pc(mean(h1), 2)}/${pc(mean(h2), 2)} ${ok ? '  ✓✓✓' : ''}`);
}
console.log('\n※ 펀딩수취는 양수가 받은 것. 가격손익은 두 다리 평균이라 시장 방향이 상쇄된 값이다.');
