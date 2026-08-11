/* 스코어 로직 재검토 — 모멘텀을 뒤집으면 나아지는가.
 *
 * 출발점이 된 관측: 확신이 높을수록 방향 성과가 나빠 보였다.
 *   59일 리플레이(4h 방향 초과수익)  ◎ −0.18%p (t=−0.42)
 *   라이브 재구성(건당 순손익)        높음 −4.05% (확정 15건)
 * 둘 다 유의하지 않은데 방향이 같다는 이유로 패턴으로 취급했다. 그건 틀린 추론이다 —
 * 유의하지 않은 관측을 겹친다고 유의해지지 않는다.
 *
 * 이 스크립트의 결론: 변형 5종 × 등급 4개 = 20칸에서 |t|≥2 가 하나도 없다(최대 1.5).
 * 20칸이면 우연히 1개쯤 나오는 것이 정상인데 그보다도 조용하다.
 * 등급 순서는 노이즈이고, '로직이 거꾸로 작동한다'는 근거도 '제대로 작동한다'는
 * 근거도 없다. 스코어의 방향 성분에는 측정 가능한 정보가 없다.
 *
 * 원인 가설: 8개 팩터 중 모멘텀·추세·효율(0.48)이 전부 '이미 그 방향으로 움직인 것'을
 * 높게 준다. 알트 무기한의 단기 횡단면 모멘텀은 되돌린다. 그래서 꼭대기를 사고 있다.
 *
 * 이미 시도한 것과의 차이: '모델 반대매매'는 같은 종목을 반대 방향으로 갔을 뿐이다.
 * 여기서는 **가중치 부호를 뒤집어 다시 순위를 매긴다** — 고르는 종목 자체가 달라진다.
 *
 * 판정은 지금까지 배운 기준을 전부 적용한다.
 *   비용 반영 · 방향 일치 기준선 대비 초과 · 겹침 보정 t · 전후반 일치
 *
 * 사용법: node tools/reversal.mjs
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
const WARMUP = Math.max(CFG.BARS, BARS_24H) + 2;
const STEP = +arg('step', 48);        // 4시간 간격 = 보유기간과 같게 두어 중복 최소화
const HOLD = +arg('hold', 48);
const COST = 0.14;

/* 원본 가중치를 보관해 두고 변형마다 갈아 끼운다.
 * Score.WEIGHTS 는 scoreSide 가 클로저로 잡고 있는 바로 그 객체라
 * 속성을 바꾸면 채점 동작이 함께 바뀐다(별도 구현을 두지 않기 위한 선택). */
const BASE = { ...Score.WEIGHTS };

const VARIANTS = [
  { id: 'base', label: '현재 (모멘텀 추종)', w: { ...BASE } },
  {
    id: 'rev_mom', label: '모멘텀만 반전',
    w: { ...BASE, mom_1h: -BASE.mom_1h, mom_4h: -BASE.mom_4h },
  },
  {
    id: 'rev_all', label: '추세성 전부 반전',
    w: { ...BASE, mom_1h: -BASE.mom_1h, mom_4h: -BASE.mom_4h,
         trend: -BASE.trend, efficiency: -BASE.efficiency },
  },
  {
    id: 'no_mom', label: '추세성 제거 (거래량·OI·펀딩만)',
    w: { ...BASE, mom_1h: 0, mom_4h: 0, trend: 0, efficiency: 0 },
  },
  {
    id: 'rsi_only', label: 'RSI 역전만 (과열 반대)',
    w: { vol_surge: 0, mom_1h: 0, mom_4h: 0, trend: 0,
         rsi_q: -BASE.rsi_q, efficiency: 0, oi_align: 0, funding_room: 0 },
  },
];

/* ---------------------------------------------------------------- 데이터 */

const data = {};
for (const fn of fs.readdirSync(CACHE).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE, fn), 'utf8'));
  if (!d.klines || d.klines.length < WARMUP + HOLD + 5) continue;
  const idx = new Map(); d.klines.forEach((k, i) => idx.set(k[0], i));
  const oiMap = new Map();
  for (const [t, v] of d.oi || []) oiMap.set(t, v);
  data[d.symbol] = { kl: d.klines, idx, oiMap, fund: d.funding || [] };
}
const symbols = Object.keys(data);
console.error(`캐시 ${symbols.length}종목 · 변형 ${VARIANTS.length}종`);

const fundingAt = (s, t) => {
  const f = data[s].fund;
  if (!f.length) return null;
  let lo = 0, hi = f.length - 1, a = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (f[m][0] <= t) { a = m; lo = m + 1; } else hi = m - 1; }
  return a < 0 ? null : f[a][1];
};
const fundCost = (s, t0, t1, side) => {
  let paid = 0;
  for (const [ts, r] of data[s].fund) if (ts > t0 && ts <= t1) paid += (side === 'LONG' ? r : -r) * 100;
  return paid;
};
const oiAt = (s, t) => {
  const m = data[s].oiMap, a = m.get(t - 12 * BAR_MS), b = m.get(t);
  return (a > 0 && b > 0) ? { chgPct: (b / a - 1) * 100 } : null;
};
const tickAt = (s, i) => {
  const kl = data[s].kl;
  if (i < BARS_24H) return null;
  let q = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) q += +kl[j][7];
  const p = +kl[i - BARS_24H][4], n = +kl[i][4];
  return { quoteVolume: q, priceChangePercent: p ? (n / p - 1) * 100 : 0 };
};

function ret(sym, i, side) {
  const kl = data[sym].kl;
  if (i + 1 >= kl.length || i + HOLD >= kl.length) return null;
  if (kl[i + HOLD][0] - kl[i][0] !== HOLD * BAR_MS) return null;
  const a = +kl[i + 1][1], b = +kl[i + HOLD][4];
  if (!(a > 0 && b > 0)) return null;
  const gross = (b / a - 1) * 100 * (side === 'SHORT' ? -1 : 1);
  return gross - COST - fundCost(sym, kl[i + 1][0], kl[i + HOLD][6], side);
}

/* ------------------------------------------------------------- 스윕 */

const allT = new Set();
for (const s of symbols) for (const k of data[s].kl) allT.add(k[0]);
const times = [...allT].sort((a, b) => a - b).filter((t, _, a) =>
  t >= a[0] + WARMUP * BAR_MS && t <= a[a.length - 1] - HOLD * BAR_MS && (t / BAR_MS) % STEP === 0);
console.error(`평가 시각 ${times.length}개`);

const R = {};
VARIANTS.forEach((v) => { R[v.id] = []; });

let done = 0;
for (const t of times) {
  const pool = [];
  for (const sym of symbols) {
    const i = data[sym].idx.get(t);
    if (i == null || i < WARMUP) continue;
    const tk = tickAt(sym, i);
    if (!tk || tk.quoteVolume < CFG.MIN_QV_UNIVERSE) continue;
    pool.push({ sym, i, tk, qv: tk.quoteVolume });
  }
  if (pool.length < 20) continue;
  pool.sort((a, b) => b.qv - a.qv);

  const feats = [];
  for (const u of pool.slice(0, CFG.UNIVERSE_SIZE)) {
    const bars = data[u.sym].kl.slice(u.i - CFG.BARS + 1, u.i + 1);
    if (bars.length < CFG.BARS || bars[bars.length - 1][0] - bars[0][0] !== (CFG.BARS - 1) * BAR_MS) continue;
    const f = Score.buildFeatures(u.sym, bars, u.tk,
      { fundingRate: fundingAt(u.sym, t), nextFundingTime: null },
      oiAt(u.sym, t), { base: u.sym.replace(/USDT$/, ''), pricePrecision: 4, onboard: 0 });
    if (f) { f._i = u.i; feats.push(f); }
  }
  if (feats.length < 20) continue;

  const eligible = feats.filter((f) => f.qv24 >= CFG.MIN_QV_RECO);
  if (eligible.length < CFG.TOP_N + 5) continue;

  // 방향 일치 기준선: 같은 시각·같은 방향으로 자격 풀에서 아무거나
  const poolRet = { LONG: [], SHORT: [] };
  for (const f of eligible) {
    for (const sd of ['LONG', 'SHORT']) {
      const r = ret(f.symbol, f._i, sd);
      if (r != null) poolRet[sd].push(r);
    }
  }
  const baseAvg = {
    LONG: poolRet.LONG.length ? poolRet.LONG.reduce((a, b) => a + b, 0) / poolRet.LONG.length : null,
    SHORT: poolRet.SHORT.length ? poolRet.SHORT.reduce((a, b) => a + b, 0) / poolRet.SHORT.length : null,
  };

  for (const v of VARIANTS) {
    Object.keys(Score.WEIGHTS).forEach((k) => { Score.WEIGHTS[k] = v.w[k]; });
    Score.scoreUniverse(feats);
    const board = feats.filter((f) => f.qv24 >= CFG.MIN_QV_RECO)
      .slice().sort((a, b) => b.score - a.score).slice(0, CFG.TOP_N);
    for (const f of board) {
      const r = ret(f.symbol, f._i, f.side);
      if (r == null) continue;
      const bs = baseAvg[f.side];
      R[v.id].push({ t, net: r, ex: bs == null ? null : r - bs, mark: f.mark });
    }
  }
  if (++done % 50 === 0) console.error(`  ${done}/${times.length}`);
}
Object.keys(Score.WEIGHTS).forEach((k) => { Score.WEIGHTS[k] = BASE[k]; });

/* ------------------------------------------------------------- 집계 */

const mid = times[Math.floor(times.length / 2)];
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pc = (v, d = 3) => v == null ? '     —' : ((v >= 0 ? '+' : '') + v.toFixed(d) + '%').padStart(9);

console.log(`\n보유 ${HOLD * 5 / 60}h · 왕복비용 ${COST}% + 펀딩 실비 · 신호 간격 ${STEP * 5 / 60}h\n`);
console.log('변형                          매매수  유효n   순손익    기준선대비    t     전반/후반');
console.log('─'.repeat(92));
for (const v of VARIANTS) {
  const rows = R[v.id];
  if (rows.length < 30) continue;
  const nets = rows.map((r) => r.net);
  const exs = rows.map((r) => r.ex).filter((x) => x != null);
  const m = mean(exs);
  const sd = Math.sqrt(exs.reduce((a, b) => a + (b - m) ** 2, 0) / (exs.length - 1));
  const nEff = exs.length / Math.max(1, HOLD / STEP);
  const t = m / (sd / Math.sqrt(nEff));
  const h1 = mean(rows.filter((r) => r.t < mid && r.ex != null).map((r) => r.ex));
  const h2 = mean(rows.filter((r) => r.t >= mid && r.ex != null).map((r) => r.ex));
  const ok = m > 0 && Math.abs(t) >= 2 && h1 > 0 && h2 > 0;
  console.log(`${v.label.padEnd(28)} ${String(rows.length).padStart(6)} ${String(Math.round(nEff)).padStart(6)} ` +
    `${pc(mean(nets))} ${pc(m)}  ${t.toFixed(1).padStart(5)}  ${pc(h1, 2)}/${pc(h2, 2)} ${ok ? ' ✓✓✓' : ''}`);
}

/* 등급별. 앞선 측정에서 '확신이 높을수록 나쁘다'가 나왔는데 표본을 바꾸니
 * 순서가 뒤집혔다. 평균만 보면 매번 다른 이야기가 나오므로 표본 수와 t를 함께 찍는다.
 * |t|<2 면 순서를 논할 근거가 없다는 뜻이다. */
console.log('\n등급별 기준선 대비 초과 — 평균 (n, t)');
for (const v of VARIANTS) {
  const rows = R[v.id];
  if (rows.length < 30) continue;
  const parts = ['◎', '○', '△', '※'].map((m2) => {
    const e = rows.filter((r) => r.mark === m2 && r.ex != null).map((r) => r.ex);
    if (e.length < 20) return '등급없음';
    const mm = mean(e);
    const sd = Math.sqrt(e.reduce((a, b) => a + (b - mm) ** 2, 0) / (e.length - 1));
    const tt = mm / (sd / Math.sqrt(e.length));
    const nm = { '◎': '높음', '○': '보통', '△': '낮음', '※': '관망' }[m2];
    return `${nm} ${(mm >= 0 ? '+' : '') + mm.toFixed(3)}% (n=${e.length}, t=${tt.toFixed(1)})`;
  });
  console.log(`  ${v.label}`);
  console.log(`    ${parts.join('  ·  ')}`);
}
console.log('\n※ |t|≥2 인 칸이 하나도 없으면 등급 순서는 노이즈다.');
