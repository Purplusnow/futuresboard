/* 보유기간 스윕 — 4시간이 아니라 며칠을 들고 있으면 달라지는가.
 *
 * 가설: 왕복 0.14%는 4시간 수익률(평균 |2.2%|) 대비 치명적이지만, 3일·7일 수익률
 * 대비로는 미미하다. 비용이 희석되는 구간에서 신호가 살아남는지 본다.
 * 추세추종(CTA)이 며칠~몇 달 단위에서 도는 것도 같은 이유다.
 *
 * 판정 기준은 지금까지 배운 것을 전부 적용한다. 하나라도 빠지면 없는 우위를 만들어낸다.
 *   1) 비용 반영 순수익이 양(+)일 것
 *   2) 대조군(자격 풀 전부 롱) 대비 초과일 것 — 그냥 시장이 오른 것과 구분
 *   3) 겹침 보정 t가 2 이상일 것 — 긴 보유는 표본이 심하게 겹친다
 *   4) 전반/후반 양쪽에서 성립할 것
 *
 * 피처는 신호 시각당 한 번만 계산하고 모든 보유기간이 공유한다.
 *
 * 사용법: node tools/horizon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
globalThis.window = globalThis;
for (const f of ['docs/config.js', 'docs/lib/indicators.js', 'docs/lib/score.js', 'docs/lib/alerts.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const CACHE = path.join(ROOT, '.cache');
const BAR_MS = 5 * 60 * 1000;
const BARS_24H = 288;
const WARMUP = Math.max(CFG.BARS, BARS_24H) + 2;
const STEP = +arg('step', 48);           // 신호 간격 4시간 — 가장 짧은 보유와 같게 두어 중복을 줄인다
const COST = 0.14;                       // 왕복 수수료+슬리피지 (%)

const HOLDS = [
  ['4h', 48], ['12h', 144], ['1d', 288], ['2d', 576], ['3d', 864], ['7d', 2016],
];
const MAX_H = Math.max(...HOLDS.map((h) => h[1]));

const STRATS = [
  { id: 'model_dir', label: '모델 방향', pick: (F) => board(F).map((f) => ({ f, side: f.side })) },
  { id: 'model_fade', label: '모델 반대', pick: (F) => board(F).map((f) => ({ f, side: f.side === 'LONG' ? 'SHORT' : 'LONG' })) },
  { id: 'mark_top', label: '추천강도 높음만', pick: (F) => board(F).filter((f) => f.mark === '◎').map((f) => ({ f, side: f.side })) },
  { id: 'control', label: '대조군(전부 롱)', pick: (F) => eligible(F).map((f) => ({ f, side: 'LONG' })) },
];
const eligible = (F) => F.filter((f) => f.qv24 >= CFG.MIN_QV_RECO);
const board = (F) => eligible(F).sort((a, b) => b.score - a.score).slice(0, CFG.TOP_N);

/* ---------------------------------------------------------------- 데이터 */

const data = {};
for (const fn of fs.readdirSync(CACHE).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE, fn), 'utf8'));
  if (!d.klines || d.klines.length < WARMUP + MAX_H + 5) continue;
  const idx = new Map();
  d.klines.forEach((k, i) => idx.set(k[0], i));
  const oiMap = new Map();
  for (const [t, v] of d.oi || []) oiMap.set(t, v);
  data[d.symbol] = { ...d, idx, oiMap };
}
const symbols = Object.keys(data);
console.error(`캐시 ${symbols.length}종목 · 보유기간 ${HOLDS.map((h) => h[0]).join('/')}`);

const fundingAt = (sym, t) => {
  const f = data[sym].funding;
  if (!f || !f.length) return null;
  let lo = 0, hi = f.length - 1, a = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (f[m][0] <= t) { a = m; lo = m + 1; } else hi = m - 1; }
  return a < 0 ? null : f[a][1];
};
/* 보유가 길수록 펀딩이 지배적이 된다. 7일이면 정산이 21번이다. */
const fundingCost = (sym, t0, t1, side) => {
  let paid = 0;
  for (const [ts, rate] of data[sym].funding || []) {
    if (ts > t0 && ts <= t1) paid += (side === 'LONG' ? rate : -rate) * 100;
  }
  return paid;
};
const oiChgAt = (sym, t) => {
  const m = data[sym].oiMap;
  const a = m.get(t - 12 * BAR_MS), b = m.get(t);
  return (a > 0 && b > 0) ? { chgPct: (b / a - 1) * 100 } : null;
};
const tickerAt = (sym, i) => {
  const kl = data[sym].klines;
  if (i < BARS_24H) return null;
  let qv = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) qv += +kl[j][7];
  const past = +kl[i - BARS_24H][4], now = +kl[i][4];
  return { quoteVolume: qv, priceChangePercent: past ? (now / past - 1) * 100 : 0 };
};

function tradeRet(sym, i, hold, side) {
  const kl = data[sym].klines;
  if (i + 1 >= kl.length || i + hold >= kl.length) return null;
  if (kl[i + hold][0] - kl[i][0] !== hold * BAR_MS) return null;   // 상장 공백
  const entry = +kl[i + 1][1], exit = +kl[i + hold][4];
  if (!(entry > 0) || !(exit > 0)) return null;
  const gross = (exit / entry - 1) * 100 * (side === 'SHORT' ? -1 : 1);
  const fund = fundingCost(sym, kl[i + 1][0], kl[i + hold][6], side);
  return { gross, fund, net: gross - COST - fund };
}

/* ------------------------------------------------------------- 스윕 */

const allT = new Set();
for (const s of symbols) for (const k of data[s].klines) allT.add(k[0]);
const times = [...allT].sort((a, b) => a - b);
const evalTimes = times.filter((t, _, arr) =>
  t >= arr[0] + WARMUP * BAR_MS && t <= arr[arr.length - 1] - MAX_H * BAR_MS && (t / BAR_MS) % STEP === 0);
console.error(`신호 시각 ${evalTimes.length}개 (${STEP * 5 / 60}시간 간격)`);

// results[strat][hold] = [{t, net, gross}]
const R = {};
for (const s of STRATS) { R[s.id] = {}; for (const [hk] of HOLDS) R[s.id][hk] = []; }

let done = 0;
for (const t of evalTimes) {
  const pool = [];
  for (const sym of symbols) {
    const i = data[sym].idx.get(t);
    if (i == null || i < WARMUP) continue;
    const tick = tickerAt(sym, i);
    if (!tick || tick.quoteVolume < CFG.MIN_QV_UNIVERSE) continue;
    pool.push({ sym, i, qv: tick.quoteVolume, tick });
  }
  if (pool.length < 20) continue;
  pool.sort((a, b) => b.qv - a.qv);

  const F = [];
  for (const u of pool.slice(0, CFG.UNIVERSE_SIZE)) {
    const bars = data[u.sym].klines.slice(u.i - CFG.BARS + 1, u.i + 1);
    if (bars.length < CFG.BARS || bars[bars.length - 1][0] - bars[0][0] !== (CFG.BARS - 1) * BAR_MS) continue;
    const f = Score.buildFeatures(u.sym, bars, u.tick,
      { fundingRate: fundingAt(u.sym, t), nextFundingTime: null },
      oiChgAt(u.sym, t), { base: u.sym.replace(/USDT$/, ''), pricePrecision: 4, onboard: 0 });
    if (f) { f._i = u.i; F.push(f); }
  }
  if (F.length < 20) continue;
  Score.scoreUniverse(F);

  // 자격 풀 전체의 '롱 기준' 순수익 평균. 숏 기준은 부호만 뒤집으면 된다
  // (가격 부분만. 펀딩·수수료는 방향에 따라 따로 계산된 값이 이미 들어있다).
  const poolAvg = {};
  const elig = eligible(F);
  for (const [hk, hold] of HOLDS) {
    const L = [], S = [];
    for (const f of elig) {
      const rl = tradeRet(f.symbol, f._i, hold, 'LONG');
      const rs = tradeRet(f.symbol, f._i, hold, 'SHORT');
      if (rl) L.push(rl.net);
      if (rs) S.push(rs.net);
    }
    poolAvg[hk] = {
      LONG: L.length ? L.reduce((a, b) => a + b, 0) / L.length : null,
      SHORT: S.length ? S.reduce((a, b) => a + b, 0) / S.length : null,
    };
  }

  for (const st of STRATS) {
    const picks = st.pick(F);
    for (const [hk, hold] of HOLDS) {
      for (const p of picks) {
        const r = tradeRet(p.f.symbol, p.f._i, hold, p.side);
        if (!r) continue;
        const base = poolAvg[hk][p.side];
        R[st.id][hk].push({ t, net: r.net, gross: r.gross, fund: r.fund,
                            excess: base == null ? null : r.net - base });
      }
    }
  }
  if (++done % 50 === 0) console.error(`  ${done}/${evalTimes.length}`);
}

/* ------------------------------------------------------------- 집계 */

const mid = evalTimes[Math.floor(evalTimes.length / 2)];
function stat(rows, hold) {
  if (rows.length < 30) return null;
  const n = rows.length;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const nets = rows.map((r) => r.net);
  const m = mean(nets);
  const sd = Math.sqrt(nets.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const overlap = Math.max(1, hold / STEP);
  const nEff = n / overlap;
  const h1 = rows.filter((r) => r.t < mid), h2 = rows.filter((r) => r.t >= mid);
  return {
    n, nEff: Math.round(nEff),
    gross: mean(rows.map((r) => r.gross)),
    fund: mean(rows.map((r) => r.fund)),
    net: m,
    t: m / (sd / Math.sqrt(nEff)),
    win: nets.filter((v) => v > 0).length / n,
    h1: h1.length > 20 ? mean(h1.map((r) => r.net)) : null,
    h2: h2.length > 20 ? mean(h2.map((r) => r.net)) : null,
    ex: exStat(rows, overlap),
  };
}

/* 방향 일치 기준선 대비 초과분. 이것이 0이면 신호에 힘이 없다는 뜻이다. */
function exStat(rows, overlap) {
  const e = rows.map((r) => r.excess).filter((v) => v != null);
  if (e.length < 30) return null;
  const m = e.reduce((a, b) => a + b, 0) / e.length;
  const sd = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (e.length - 1));
  const nEff = e.length / overlap;
  const mid2 = rows[Math.floor(rows.length / 2)].t;
  const p1 = rows.filter((r) => r.t < mid2 && r.excess != null).map((r) => r.excess);
  const p2 = rows.filter((r) => r.t >= mid2 && r.excess != null).map((r) => r.excess);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  return { mean: m, t: m / (sd / Math.sqrt(nEff)), h1: avg(p1), h2: avg(p2) };
}

const pc = (v, d = 3) => v == null ? '     —' : ((v >= 0 ? '+' : '') + v.toFixed(d) + '%').padStart(8);

console.log(`\n비용 왕복 ${COST}% + 펀딩 실비 · 진입 다음 봉 시가 · 신호 간격 ${STEP * 5 / 60}h\n`);
for (const st of STRATS) {
  console.log(`── ${st.label}`);
  console.log('   보유    매매수  유효n   총수익    펀딩     순수익    승률   t      전반/후반');
  for (const [hk, hold] of HOLDS) {
    const s = stat(R[st.id][hk], hold);
    if (!s) continue;
    const ok = s.net > 0 && Math.abs(s.t) >= 2 && s.h1 > 0 && s.h2 > 0;
    console.log(`   ${hk.padEnd(5)} ${String(s.n).padStart(7)} ${String(s.nEff).padStart(6)} ` +
      `${pc(s.gross)} ${pc(-s.fund)} ${pc(s.net)}  ${(s.win * 100).toFixed(1)}%  ` +
      `${s.t.toFixed(1).padStart(5)}  ${pc(s.h1, 2)}/${pc(s.h2, 2)} ${ok ? '  ✓✓✓' : ''}`);
  }
  console.log('');
}

// 방향 일치 기준선 대비 초과 — 시장 방향과 방향 편향을 모두 제거한 값.
// '전부 롱' 대조군만 쓰면 숏 편향 전략이 하락장에서 실력처럼 보인다.
console.log('── 방향 일치 기준선 대비 초과 (시장 방향 + 방향 편향 제거)');
console.log('   보유        모델 방향 (t)        모델 반대 (t)        강도높음 (t)      전·후반 일치');
for (const [hk, hold] of HOLDS) {
  let row = `   ${hk.padEnd(6)}`;
  const flags = [];
  for (const id of ['model_dir', 'model_fade', 'mark_top']) {
    const s = stat(R[id][hk], hold);
    const e = s && s.ex;
    row += e ? `${pc(e.mean)} (${e.t.toFixed(1).padStart(5)})   ` : '        —          ';
    if (e) flags.push(`${id === 'model_dir' ? '방향' : id === 'model_fade' ? '반대' : '강도높음'}:` +
      (e.h1 > 0 && e.h2 > 0 ? '++' : e.h1 < 0 && e.h2 < 0 ? '--' : '±'));
  }
  console.log(row + '  ' + flags.join(' '));
}
console.log('\n※ 전·후반 일치: ++ 양쪽 양수 / -- 양쪽 음수 / ± 엇갈림. |t|≥2 이면서 ++ 여야 신호로 인정한다.');
