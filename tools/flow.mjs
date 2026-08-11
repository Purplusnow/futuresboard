/* 주문 흐름(테이커 매수세) 신호 검정 — "평소와 다른 매수세"에 정보가 있는가.
 *
 * 지금까지 쓴 것은 5분봉의 시·고·저·종가와 거래량뿐이었다. 그런데 봉에는
 * '그 거래량 중 얼마가 매수 주도 체결이었나'(taker_buy_quote_volume)가 함께 들어 있다.
 * 같은 5천만 달러가 거래돼도 매수가 밀어올린 것과 매도가 던진 것은 다른 사건인데,
 * 그 구분을 여태 버리고 있었다.
 *
 * ── 왜 전략이 아니라 IC부터 재는가 ────────────────────────────────────────
 * 전략은 신호·비용·포지션 구성이 뒤엉켜 있어서 실패해도 어디가 문제인지 모른다.
 * IC(신호 순위 vs 미래 수익률 순위의 상관)는 신호에 정보가 있는지만 본다.
 * 정보가 없으면 어떤 전략으로도 못 만든다. 있으면 그때 비용을 붙여본다.
 *
 * IC는 각 시각에 '횡단면'으로 계산하므로 시장이 통째로 오르내린 부분은 자동으로 빠진다.
 * 앞서 '하락장 숏 편향'에 속았던 함정이 구조적으로 차단된다.
 *
 * ── 대조 신호 ─────────────────────────────────────────────────────────────
 * 정보가 있을 리 없는 신호(심볼·시각 해시)를 같이 돌린다. 이게 유의하게 나오면
 * 측정 장치가 고장난 것이다. 결과를 믿기 전에 이걸 먼저 본다.
 *
 * 사용법: node tools/flow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
globalThis.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'docs/config.js'), 'utf8'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const CACHE = path.join(ROOT, '.cache');
const BAR_MS = 5 * 60 * 1000;
const BARS_24H = 288;
const BASE = 72;                  // 평소 = 직전 6시간
const RECENT = 3;                 // 최근 = 15분
const WARMUP = BARS_24H + BASE + RECENT + 2;
const STEP = +arg('step', 12);    // 1시간마다 평가
const COST = 0.14;

/* 진입 지연(GAP). 기본 1봉 = 신호 다음 봉 시가.
 *
 * 매수가 몰린 봉은 종가가 매도호가 쪽에 붙는다. 그 직후 가격으로 진입하면
 * 이후 수익률이 반스프레드만큼 음수로 기울고, 그게 '매수세 뒤엔 하락'이라는
 * 가짜 신호로 보인다. 실측 반스프레드 0.0132%는 관측된 스프레드 0.033%p의 40%다.
 * 진입을 몇 봉 늦춰서 효과가 살아남는지 본다 — 살아남으면 진짜, 사라지면 착시. */
const GAP = +arg('gap', 1);

const HORIZ = [['15m', 3], ['1h', 12], ['4h', 48], ['1d', 288]];
const MAX_H = 288;

/* ---------------------------------------------------------------- 데이터 */

const data = {};
for (const fn of fs.readdirSync(CACHE).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE, fn), 'utf8'));
  if (!d.klines || d.klines.length < WARMUP + MAX_H + 5) continue;
  if (d.klines[0].length < 11) continue;          // 테이커 필드가 없는 낡은 캐시
  const idx = new Map(); d.klines.forEach((k, i) => idx.set(k[0], i));
  data[d.symbol] = { kl: d.klines, idx };
}
const symbols = Object.keys(data);
console.error(`캐시 ${symbols.length}종목 (테이커 매수량 보유)`);
if (!symbols.length) { console.error('테이커 필드가 있는 캐시가 없습니다. fetch_history.py --refresh 필요'); process.exit(1); }

/* ------------------------------------------------------------- 신호 정의 */

/* 봉 하나의 매수 비율. 0.5면 균형, 1이면 전부 매수 주도. */
const ratio = (k) => { const q = +k[7]; return q > 0 ? +k[10] / q : null; };

const FEATURES = [
  {
    id: 'buy_z',
    label: '매수세 이상치 (z)',
    desc: '최근 15분 매수비율이 자기 평소(직전 6h) 대비 몇 표준편차인가 — "평소와 다른 매수세"',
    calc: (kl, i) => {
      const rec = [], base = [];
      for (let j = i - RECENT + 1; j <= i; j++) { const r = ratio(kl[j]); if (r != null) rec.push(r); }
      for (let j = i - RECENT - BASE + 1; j <= i - RECENT; j++) { const r = ratio(kl[j]); if (r != null) base.push(r); }
      if (rec.length < RECENT || base.length < BASE * 0.8) return null;
      const m = base.reduce((a, b) => a + b, 0) / base.length;
      const sd = Math.sqrt(base.reduce((a, b) => a + (b - m) ** 2, 0) / (base.length - 1));
      if (!(sd > 0)) return null;
      const rm = rec.reduce((a, b) => a + b, 0) / rec.length;
      return (rm - m) / sd;
    },
  },
  {
    id: 'buy_ratio',
    label: '매수비율 원값',
    desc: '최근 15분 매수 주도 비율 그 자체 (자기 기준 정규화 없음)',
    calc: (kl, i) => {
      let q = 0, b = 0;
      for (let j = i - RECENT + 1; j <= i; j++) { q += +kl[j][7]; b += +kl[j][10]; }
      return q > 0 ? b / q : null;
    },
  },
  {
    id: 'net_buy_surge',
    label: '순매수 금액 급증',
    desc: '최근 15분 순매수액(매수-매도)이 평소 절대 순매수액의 몇 배인가',
    calc: (kl, i) => {
      let net = 0;
      for (let j = i - RECENT + 1; j <= i; j++) { const q = +kl[j][7], b = +kl[j][10]; net += b - (q - b); }
      let sum = 0, n = 0;
      for (let j = i - RECENT - BASE + 1; j <= i - RECENT; j++) {
        const q = +kl[j][7], b = +kl[j][10];
        sum += Math.abs(b - (q - b)); n++;
      }
      const avg = n ? sum / n : 0;
      return avg > 0 ? net / avg : null;
    },
  },
  {
    id: 'cvd_1h',
    label: '누적 순매수 기울기 (1h)',
    desc: '최근 1시간 순매수 누적을 총 거래대금으로 나눈 값 — 지속적인 한쪽 쏠림',
    calc: (kl, i) => {
      let net = 0, tot = 0;
      for (let j = i - 12 + 1; j <= i; j++) { const q = +kl[j][7], b = +kl[j][10]; net += b - (q - b); tot += q; }
      return tot > 0 ? net / tot : null;
    },
  },
  {
    id: 'absorption',
    label: '흡수 (매수세 강한데 가격 정체)',
    desc: '매수 z가 높은데 가격이 안 오르면 위에서 물량이 소화되고 있다는 뜻',
    calc: (kl, i) => {
      const f = FEATURES[0].calc(kl, i);
      if (f == null) return null;
      const c0 = +kl[i - RECENT][4], c1 = +kl[i][4];
      if (!(c0 > 0)) return null;
      const move = Math.abs((c1 / c0 - 1) * 100);
      return f / (move + 0.05);        // 같은 매수세라도 가격이 덜 움직였으면 큰 값
    },
  },
  {
    id: '_control',
    label: '대조 신호 (정보 없음)',
    desc: '심볼·시각 해시. 이게 유의하면 측정 장치가 고장난 것이다',
    calc: (kl, i, sym) => {
      let h = 0;
      const s = sym + kl[i][0];
      for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
      return (h % 10007) / 10007;
    },
  },
];

/* ------------------------------------------------------------- IC 계산 */

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 10) return null;
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const m = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - m) * (ry[i] - m);
    dx += (rx[i] - m) ** 2; dy += (ry[i] - m) ** 2;
  }
  return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
}

function fwd(sym, i, h) {
  const kl = data[sym].kl;
  const e = i + GAP;                       // 진입 봉
  if (e >= kl.length || i + GAP + h >= kl.length) return null;
  if (kl[i + GAP + h][0] - kl[i][0] !== (GAP + h) * BAR_MS) return null;
  const a = +kl[e][1], b = +kl[i + GAP + h][4];
  return (a > 0 && b > 0) ? (b / a - 1) * 100 : null;
}
function qv24(sym, i) {
  const kl = data[sym].kl;
  let q = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) q += +kl[j][7];
  return q;
}

const allT = new Set();
for (const s of symbols) for (const k of data[s].kl) allT.add(k[0]);
const times = [...allT].sort((a, b) => a - b);
const evalTimes = times.filter((t, _, a) =>
  t >= a[0] + WARMUP * BAR_MS && t <= a[a.length - 1] - MAX_H * BAR_MS && (t / BAR_MS) % STEP === 0);
console.error(`평가 시각 ${evalTimes.length}개 · 신호 ${FEATURES.length}종 · 지평 ${HORIZ.map((h) => h[0]).join('/')}`);

// IC[feature][horizon] = [{t, ic}]
const IC = {}; const DEC = {};
for (const f of FEATURES) { IC[f.id] = {}; DEC[f.id] = {}; for (const [hk] of HORIZ) { IC[f.id][hk] = []; DEC[f.id][hk] = []; } }

let done = 0;
for (const t of evalTimes) {
  const pool = [];
  for (const sym of symbols) {
    const i = data[sym].idx.get(t);
    if (i == null || i < WARMUP) continue;
    if (qv24(sym, i) < CFG.MIN_QV_RECO) continue;
    pool.push({ sym, i });
  }
  if (pool.length < 15) continue;

  const rets = {};
  for (const [hk, h] of HORIZ) rets[hk] = pool.map((p) => fwd(p.sym, p.i, h));

  for (const f of FEATURES) {
    const vals = pool.map((p) => f.calc(data[p.sym].kl, p.i, p.sym));
    for (const [hk] of HORIZ) {
      const xs = [], ys = [];
      for (let k = 0; k < pool.length; k++) {
        if (vals[k] == null || !isFinite(vals[k]) || rets[hk][k] == null) continue;
        xs.push(vals[k]); ys.push(rets[hk][k]);
      }
      const ic = spearman(xs, ys);
      if (ic != null) IC[f.id][hk].push({ t, ic });

      // 상·하위 20% 스프레드 — 실제로 매매 가능한 폭인지 본다
      if (xs.length >= 20) {
        const ord = xs.map((v, k) => [v, ys[k]]).sort((a, b) => a[0] - b[0]);
        const q = Math.max(3, Math.floor(ord.length * 0.2));
        const lo = ord.slice(0, q).reduce((a, b) => a + b[1], 0) / q;
        const hi = ord.slice(-q).reduce((a, b) => a + b[1], 0) / q;
        DEC[f.id][hk].push({ t, spread: hi - lo });
      }
    }
  }
  if (++done % 200 === 0) console.error(`  ${done}/${evalTimes.length}`);
}

/* ------------------------------------------------------------- 집계 */

const mid = evalTimes[Math.floor(evalTimes.length / 2)];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`\n진입 지연 GAP=${GAP}봉(${GAP * 5}분) · 비중첩 보정 t · 대조 신호 포함 · 왕복비용 ${COST}%\n`);
for (const f of FEATURES) {
  console.log(`── ${f.label}${f.id === '_control' ? '' : ''}`);
  console.log(`   ${f.desc}`);
  console.log('   지평    표본   평균IC      t     양수%   상하위20%스프레드  비용차감   전반/후반');
  for (const [hk, h] of HORIZ) {
    const rows = IC[f.id][hk];
    if (rows.length < 30) continue;
    const ics = rows.map((r) => r.ic);
    const m = mean(ics);
    const sd = Math.sqrt(ics.reduce((a, b) => a + (b - m) ** 2, 0) / (ics.length - 1));
    const nEff = rows.length / Math.max(1, h / STEP);
    const t = m / (sd / Math.sqrt(nEff));
    const pos = ics.filter((v) => v > 0).length / ics.length * 100;
    const h1 = mean(rows.filter((r) => r.t < mid).map((r) => r.ic));
    const h2 = mean(rows.filter((r) => r.t >= mid).map((r) => r.ic));
    const sp = DEC[f.id][hk].length ? mean(DEC[f.id][hk].map((r) => r.spread)) : null;
    const net = sp == null ? null : Math.abs(sp) - COST;
    const ok = Math.abs(t) >= 2 && h1 * h2 > 0;
    console.log(`   ${hk.padEnd(5)} ${String(Math.round(nEff)).padStart(6)}  ` +
      `${(m >= 0 ? '+' : '') + m.toFixed(4)}  ${t.toFixed(1).padStart(6)}   ${pos.toFixed(0)}%   ` +
      `${sp == null ? '     —' : ((sp >= 0 ? '+' : '') + sp.toFixed(3) + '%p').padStart(10)}   ` +
      `${net == null ? '    —' : ((net >= 0 ? '+' : '') + net.toFixed(3) + '%p').padStart(9)}   ` +
      `${(h1 >= 0 ? '+' : '') + h1.toFixed(3)}/${(h2 >= 0 ? '+' : '') + h2.toFixed(3)} ${ok ? ' ✓' : ''}`);
  }
  console.log('');
}
console.log('※ IC는 매 시각 횡단면 순위상관이라 시장 전체 등락은 자동으로 빠진다.');
console.log('※ ✓는 |t|≥2 이고 전·후반 부호가 같다는 뜻. 대조 신호에 ✓가 뜨면 측정 장치를 의심해야 한다.');
console.log('※ 스프레드는 상위20% 평균수익 − 하위20% 평균수익. 이 폭이 왕복비용을 넘어야 매매가 성립한다.');
