/* 현물-선물 베이시스 거래 — 방향을 맞히지 않고 펀딩을 받는 진짜 캐리.
 *
 * 앞선 '선물 전용 펀딩 캐리'는 실패했다. 펀딩 상위를 숏하고 **다른 종목**을 롱하는
 * 방식이라 헤지가 아니라 새 가격 위험을 떠안은 것이었고, 가격손익이 펀딩수취를
 * 거의 정확히 상쇄했다(3일 -1.432% vs +1.392%).
 *
 * 이번엔 **같은 심볼**의 현물을 롱하고 선물을 숏한다. 같은 자산이라 가격 위험이
 * 실제로 지워지고, 남는 것은
 *   (1) 8시간마다 받는 펀딩,
 *   (2) 진입 시 벌어져 있던 베이시스(선물-현물 괴리)가 좁혀지며 생기는 이익,
 *   (3) 비용.
 * 이 셋뿐이다. 예측이 하나도 들어가지 않는다 — 이 프로젝트에서 처음이다.
 *
 * ── 비용 ──────────────────────────────────────────────────────────────────
 * 현물 수수료가 선물보다 비싸다는 점이 중요하다(0.1% vs 0.05%). 다리가 둘이므로
 * 왕복 합계가 0.38%까지 올라간다. 펀딩이 이걸 넘어야 남는 것이 있다.
 *
 * ── 자본 가정 ─────────────────────────────────────────────────────────────
 * 수익률은 '현물 명목금액 1단위' 기준이다. 선물 숏 증거금은 현물을 담보로
 * 충당한다고 가정한다(교차마진). 별도 증거금을 쌓아야 하면 자본이 늘어 수익률은
 * 이보다 낮아진다. 대출금리·인출제약도 반영하지 않았다.
 *
 * 사용법: node tools/basis.mjs [--k 8]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
globalThis.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'docs/config.js'), 'utf8'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const FUT = path.join(ROOT, '.cache');
const SPT = path.join(ROOT, '.cache_spot');
const BAR_MS = 5 * 60 * 1000;
const BARS_24H = 288;
const K = +arg('k', 8);
const STEP = +arg('step', 96);        // 8시간 = 펀딩 정산 주기

/* 편도 비용(%). 현물이 선물보다 비싸다 — 이 차이가 이 거래의 성패를 가른다. */
const FEE = { spot: 0.10, perp: 0.05, slip: 0.02 };
const COST = (FEE.spot + FEE.slip) * 2 + (FEE.perp + FEE.slip) * 2;   // 0.38%

const HOLDS = [['8h', 96], ['1d', 288], ['3d', 864], ['7d', 2016], ['14d', 4032]];
const MAX_H = Math.max(...HOLDS.map((h) => h[1]));

/* ---------------------------------------------------------------- 데이터 */

const F = {}, S = {};
for (const fn of fs.readdirSync(FUT).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const d = JSON.parse(fs.readFileSync(path.join(FUT, fn), 'utf8'));
  if (!d.klines || !d.funding || !d.funding.length) continue;
  const idx = new Map(); d.klines.forEach((k, i) => idx.set(k[0], i));
  F[d.symbol] = { kl: d.klines, idx, fund: d.funding };
}
if (fs.existsSync(SPT)) {
  for (const fn of fs.readdirSync(SPT).filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(SPT, fn), 'utf8'));
    const idx = new Map(); d.klines.forEach((k, i) => idx.set(k[0], i));
    S[d.symbol] = { kl: d.klines, idx };
  }
}
const pairs = Object.keys(F).filter((s) => S[s] && F[s].kl.length > MAX_H + BARS_24H + 10
                                              && S[s].kl.length > MAX_H + BARS_24H + 10);
console.error(`선물 ${Object.keys(F).length} · 현물 ${Object.keys(S).length} · 양쪽 보유 ${pairs.length}종목`);
if (pairs.length < K * 2) { console.error('종목이 부족합니다'); process.exit(1); }

const fundingAt = (s, t) => {
  const f = F[s].fund;
  let lo = 0, hi = f.length - 1, a = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (f[m][0] <= t) { a = m; lo = m + 1; } else hi = m - 1; }
  return a < 0 ? null : f[a][1];
};
/* 숏이면 펀딩이 양수일 때 받는다. 반환값은 % 이고 양수 = 수취. */
const fundingRecv = (s, t0, t1) => {
  let got = 0;
  for (const [ts, rate] of F[s].fund) if (ts > t0 && ts <= t1) got += rate * 100;
  return got;
};
const qv24 = (s, i) => {
  const kl = F[s].kl;
  if (i < BARS_24H) return null;
  let q = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) q += +kl[j][7];
  return q;
};

/* 한 쌍의 손익. 현물 명목금액 1단위 기준(%). */
function pairPnl(sym, t, hold) {
  const fi = F[sym].idx.get(t), si = S[sym].idx.get(t);
  if (fi == null || si == null) return null;
  const fk = F[sym].kl, sk = S[sym].kl;
  if (fi + 1 >= fk.length || fi + hold >= fk.length) return null;
  if (si + 1 >= sk.length || si + hold >= sk.length) return null;
  // 두 시장 모두 봉이 연속이어야 한다(거래정지·상장공백 방어)
  if (fk[fi + hold][0] - fk[fi][0] !== hold * BAR_MS) return null;
  if (sk[si + hold][0] - sk[si][0] !== hold * BAR_MS) return null;

  const pIn = +fk[fi + 1][1], pOut = +fk[fi + hold][4];
  const sIn = +sk[si + 1][1], sOut = +sk[si + hold][4];
  if (!(pIn > 0 && pOut > 0 && sIn > 0 && sOut > 0)) return null;

  const perp = -(pOut / pIn - 1) * 100;          // 선물 숏
  const spot = (sOut / sIn - 1) * 100;           // 현물 롱
  const fund = fundingRecv(sym, fk[fi + 1][0], fk[fi + hold][6]);
  const basisIn = (pIn / sIn - 1) * 100;         // 진입 시 선물 프리미엄
  return { perp, spot, fund, basisIn, price: perp + spot, net: perp + spot + fund - COST };
}

/* ------------------------------------------------------------- 시뮬레이션 */

const allT = new Set();
for (const s of pairs) for (const k of F[s].kl) allT.add(k[0]);
const times = [...allT].sort((a, b) => a - b);
const evalTimes = times.filter((t, _, a) =>
  t >= a[0] + BARS_24H * BAR_MS && t <= a[a.length - 1] - MAX_H * BAR_MS && (t / BAR_MS) % STEP === 0);
console.error(`신호 시각 ${evalTimes.length}개 · 비용 ${COST.toFixed(2)}% (현물 왕복 ${((FEE.spot+FEE.slip)*2).toFixed(2)}% + 선물 왕복 ${((FEE.perp+FEE.slip)*2).toFixed(2)}%)`);

const R = { hi: {}, lo: {} };
for (const g of ['hi', 'lo']) for (const [hk] of HOLDS) R[g][hk] = [];

for (const t of evalTimes) {
  const cand = [];
  for (const s of pairs) {
    const i = F[s].idx.get(t);
    if (i == null || i < BARS_24H) continue;
    const q = qv24(s, i);
    if (!q || q < CFG.MIN_QV_RECO) continue;
    const fr = fundingAt(s, t);
    if (fr == null) continue;
    cand.push({ s, fr });
  }
  if (cand.length < K * 2) continue;
  cand.sort((a, b) => b.fr - a.fr);

  // hi = 펀딩 상위(받는 쪽) · lo = 펀딩 하위(내는 쪽, 대조군)
  for (const [g, sel] of [['hi', cand.slice(0, K)], ['lo', cand.slice(-K)]]) {
    for (const [hk, hold] of HOLDS) {
      const legs = [];
      for (const c of sel) { const r = pairPnl(c.s, t, hold); if (r) legs.push(r); }
      if (legs.length < Math.ceil(K / 2)) continue;
      const avg = (f) => legs.reduce((a, x) => a + f(x), 0) / legs.length;
      R[g][hk].push({ t, net: avg((x) => x.net), price: avg((x) => x.price),
                      fund: avg((x) => x.fund), basisIn: avg((x) => x.basisIn) });
    }
  }
}

/* ------------------------------------------------------------- 집계 */

const mid = evalTimes[Math.floor(evalTimes.length / 2)];
const pc = (v, d = 3) => v == null ? '      —' : ((v >= 0 ? '+' : '') + v.toFixed(d) + '%').padStart(9);

for (const [g, title] of [['hi', `펀딩 상위 ${K}종목 — 현물 롱 + 선물 숏 (받는 쪽)`],
                          ['lo', `펀딩 하위 ${K}종목 — 같은 구조 (내는 쪽, 대조군)`]]) {
  console.log(`\n── ${title}`);
  console.log('보유    회차  유효n   진입베이시스  가격손익   펀딩수취    순수익   승률    t     연환산   전·후반');
  for (const [hk, hold] of HOLDS) {
    const rows = R[g][hk];
    if (rows.length < 20) continue;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const nets = rows.map((r) => r.net);
    const m = mean(nets);
    const sd = Math.sqrt(nets.reduce((a, b) => a + (b - m) ** 2, 0) / (nets.length - 1));
    const nEff = rows.length / Math.max(1, hold / STEP);
    const t = m / (sd / Math.sqrt(nEff));
    const ann = m * (365 / (hold * 5 / 60 / 24));
    const h1 = mean(rows.filter((r) => r.t < mid).map((r) => r.net) || [0]);
    const h2 = mean(rows.filter((r) => r.t >= mid).map((r) => r.net) || [0]);
    const ok = m > 0 && Math.abs(t) >= 2 && h1 > 0 && h2 > 0;
    console.log(`${hk.padEnd(6)} ${String(rows.length).padStart(5)} ${String(Math.round(nEff)).padStart(6)} ` +
      `${pc(mean(rows.map((r) => r.basisIn)), 4)} ${pc(mean(rows.map((r) => r.price)))} ` +
      `${pc(mean(rows.map((r) => r.fund)))} ${pc(m)}  ` +
      `${(nets.filter((v) => v > 0).length / nets.length * 100).toFixed(1)}%  ${t.toFixed(1).padStart(5)} ` +
      `${(ann >= 0 ? '+' : '') + ann.toFixed(1)}%`.padStart(9) +
      `  ${pc(h1, 2)}/${pc(h2, 2)} ${ok ? '  ✓✓✓' : ''}`);
  }
}
console.log(`\n※ 가격손익 = 현물 롱 + 선물 숏 합. 헤지가 제대로 걸렸다면 0 부근이어야 한다.`);
console.log(`   (선물 전용 캐리에서는 이 값이 -1.4%까지 벌어져 펀딩을 상쇄했다)`);
console.log(`※ 연환산은 단리 환산이며 자본 재투입·복리·증거금 추가를 반영하지 않는다.`);
