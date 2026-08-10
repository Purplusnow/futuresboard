/* 과거 구간을 되돌려 '전광판이 그때 뭐라고 했는지'와 '그래서 어떻게 됐는지'를 집계한다.
 *
 * 핵심 원칙 세 가지 — 하나라도 깨지면 결과는 장식일 뿐이다.
 *
 *  1) 같은 코드로 재현한다.
 *     docs/lib/indicators.js · score.js · config.js 를 그대로 로드한다. 백테스트용
 *     별도 구현을 두면 반드시 어긋나고, 어긋난 줄도 모른 채 숫자를 믿게 된다.
 *
 *  2) 누수를 차단한다.
 *     시각 t의 판단에는 t까지의 봉만 쓴다. 24h 거래대금·24h 등락도 t 기준으로 다시 계산하고
 *     (최종값을 쓰면 미래를 아는 것이다), 펀딩비는 t 이전에 확정된 마지막 값만 쓴다.
 *     진입가는 신호가 난 봉의 종가가 아니라 '다음 봉 시가'다. 같은 봉 안에서 사는 것은 불가능하다.
 *
 *  3) 베이스라인과 비교한다.
 *     하락장에서 숏 적중률 60%는 실력이 아니다. 같은 시각·같은 방향으로 유니버스에서
 *     아무거나 골랐을 때의 적중률을 함께 내고, 그 차이만을 성과로 본다.
 *
 * 사용법: node tools/replay.mjs [--step 6] [--out docs/data/track.json]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
globalThis.window = globalThis;
for (const f of ['docs/config.js', 'docs/lib/indicators.js', 'docs/lib/score.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const STEP = +arg('step', 6);                   // 평가 간격(봉). 6 = 30분
const OUT = arg('out', 'docs/data/track.json');
const CACHE = path.join(ROOT, '.cache');

const BAR_MS = 5 * 60 * 1000;
const BARS_24H = 288;
const WARMUP = Math.max(CFG.BARS, BARS_24H) + 2; // 지표 200봉 + 24h 통계 288봉
const HORIZONS = [
  ['15m', 3],
  ['1h', 12],
  ['4h', 48],
];
const MAX_H = Math.max(...HORIZONS.map((h) => h[1]));

/* ------------------------------------------------------------------ 로드 */

const files = fs.readdirSync(CACHE).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const data = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
  if (!d.klines || d.klines.length < WARMUP + MAX_H + 10) continue;

  // 시각 → 인덱스. 상장 중간 공백이 있는 종목이 있어 인덱스 산술을 믿으면 안 된다.
  const idx = new Map();
  d.klines.forEach((k, i) => idx.set(k[0], i));

  // OI는 봉과 같은 5분 격자다. 시각으로 바로 찾는다.
  const oiMap = new Map();
  for (const [t, v] of d.oi || []) oiMap.set(t, v);

  data[d.symbol] = { ...d, idx, oiMap };
}
const symbols = Object.keys(data);
console.error(`캐시 ${symbols.length}종목 로드`);

// 평가 시각: 모든 종목의 봉 시각 합집합에서 워밍업/호라이즌 여유를 뺀 구간
const allTimes = new Set();
for (const s of symbols) for (const k of data[s].klines) allTimes.add(k[0]);
const times = [...allTimes].sort((a, b) => a - b);
const from = times[0] + WARMUP * BAR_MS;
const to = times[times.length - 1] - MAX_H * BAR_MS;
const evalTimes = times.filter((t) => t >= from && t <= to && ((t / BAR_MS) % STEP === 0));
console.error(
  `평가 시각 ${evalTimes.length}개 (${new Date(from).toISOString().slice(0, 16)} ~ ` +
  `${new Date(to).toISOString().slice(0, 16)}, ${STEP * 5}분 간격)`
);

/* -------------------------------------------------------------- 헬퍼 */

/* t 시점에 이미 확정된 마지막 펀딩비. 이분 탐색. */
function fundingAt(sym, t) {
  const f = data[sym].funding;
  if (!f || !f.length) return null;
  let lo = 0, hi = f.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (f[m][0] <= t) { ans = m; lo = m + 1; } else { hi = m - 1; }
  }
  return ans < 0 ? null : f[ans][1];
}

/* 최근 1시간 OI 변화율. 라이브의 openInterestHist(5m, 13) 과 같은 정의. */
function oiChgAt(sym, t) {
  const m = data[sym].oiMap;
  const a = m.get(t - 12 * BAR_MS), b = m.get(t);
  if (!(a > 0) || !(b > 0)) return null;
  return { chgPct: (b / a - 1) * 100 };
}

/* t 시점 기준 24h 통계를 봉에서 다시 만든다. 최종값을 쓰면 미래를 아는 것이다. */
function tickerAt(sym, i) {
  const kl = data[sym].klines;
  if (i < BARS_24H) return null;
  let qv = 0;
  for (let j = i - BARS_24H + 1; j <= i; j++) qv += +kl[j][7];
  const past = +kl[i - BARS_24H][4];
  const now = +kl[i][4];
  return {
    quoteVolume: qv,
    priceChangePercent: past ? (now / past - 1) * 100 : 0,
  };
}

/* 진입은 다음 봉 시가, 청산은 h봉 뒤 종가. 방향을 적용한 수익률(%). */
function forwardRet(sym, i, h, side) {
  const kl = data[sym].klines;
  if (i + 1 >= kl.length || i + h >= kl.length) return null;
  // 봉이 연속인지 확인한다. 상장 공백을 건너뛰면 실제보다 긴 구간을 잰 것이 된다.
  if (kl[i + h][0] - kl[i][0] !== h * BAR_MS) return null;
  const entry = +kl[i + 1][1];
  const exit = +kl[i + h][4];
  if (!(entry > 0) || !(exit > 0)) return null;
  const r = (exit / entry - 1) * 100;
  return side === 'SHORT' ? -r : r;
}

/* ------------------------------------------------------------- 리플레이 */

const signals = [];
// 베이스라인: 각 평가 시각·호라이즌마다 유니버스 전 종목의 롱 기준 수익률 분포
const baseline = {};       // key: `${t}|${hk}` -> { rets: [] }
let evaluated = 0;

for (const t of evalTimes) {
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
  if (pool.length < 20) continue;                       // 표본이 얇으면 백분위가 왜곡된다

  pool.sort((a, b) => b.qv - a.qv);
  const uni = pool.slice(0, CFG.UNIVERSE_SIZE);

  for (const u of uni) {
    const D = data[u.sym];
    const bars = D.klines.slice(u.i - CFG.BARS + 1, u.i + 1);
    // 슬라이스가 연속 구간인지 확인 (상장 공백 종목 방어)
    if (bars.length < CFG.BARS || bars[bars.length - 1][0] - bars[0][0] !== (CFG.BARS - 1) * BAR_MS) continue;

    const f = Score.buildFeatures(
      u.sym, bars, u.tick,
      { fundingRate: fundingAt(u.sym, t), nextFundingTime: null },
      oiChgAt(u.sym, t),
      { base: u.sym.replace(/USDT$/, ''), pricePrecision: 4, onboard: 0 }
    );
    if (f) { f._i = u.i; feats.push(f); }
  }
  if (feats.length < 20) continue;

  Score.scoreUniverse(feats);
  evaluated++;

  // 전광판에 오를 자격이 있는 풀(유동성 필터 통과)
  const eligible = feats.filter((f) => f.qv24 >= CFG.MIN_QV_RECO);

  // 베이스라인: '같은 자격 풀에서 무작위로 골랐다면'.
  // 유니버스 전체로 잡으면 우리가 애초에 고르지 않는 저유동 종목까지 섞여
  // 비교가 성립하지 않는다. 비교 대상은 우리가 실제로 고를 수 있었던 것들이어야 한다.
  for (const [hk, h] of HORIZONS) {
    const rets = [];
    for (const f of eligible) {
      const r = forwardRet(f.symbol, f._i, h, 'LONG');
      if (r != null) rets.push(r);
    }
    baseline[`${t}|${hk}`] = rets;
  }

  // 실제 전광판에 올라간 것만 신호로 본다 (자격 풀에서 상위 N)
  const board = eligible
    .sort((a, b) => b.score - a.score)
    .slice(0, CFG.TOP_N);

  for (const f of board) {
    const rec = { t, symbol: f.symbol, side: f.side, mark: f.mark, score: f.score, ret: {} };
    for (const [hk, h] of HORIZONS) rec.ret[hk] = forwardRet(f.symbol, f._i, h, f.side);
    signals.push(rec);
  }

  if (evaluated % 50 === 0) console.error(`  ${evaluated}/${evalTimes.length} 평가…`);
}

console.error(`평가 ${evaluated}회 · 신호 ${signals.length}건`);

/* -------------------------------------------------------------- 집계 */

function agg(rows) {
  const out = { n: rows.length };
  for (const [hk] of HORIZONS) {
    const rs = rows.map((r) => r.ret[hk]).filter((v) => v != null);
    const bs = [];
    for (const r of rows) {
      const pool = baseline[`${r.t}|${hk}`];
      if (!pool || !pool.length) continue;
      // 같은 시각·같은 방향으로 유니버스에서 무작위로 골랐을 때의 기대값
      const sign = r.side === 'SHORT' ? -1 : 1;
      bs.push({
        hit: pool.filter((v) => sign * v > 0).length / pool.length,
        ret: (sign * pool.reduce((a, b) => a + b, 0)) / pool.length,
      });
    }
    // 방향과 별개로 '움직임의 크기'를 맞히는가. 변동성은 방향보다 예측 가능하고,
    // 스크리너의 실제 효용("곧 움직일 종목을 앞에 놓았는가")은 이쪽에 가깝다.
    const absMine = rs.map(Math.abs);
    const absBase = [];
    for (const r of rows) {
      const pool = baseline[`${r.t}|${hk}`];
      if (pool && pool.length) absBase.push(pool.reduce((a, b) => a + Math.abs(b), 0) / pool.length);
    }
    out[hk] = {
      n: rs.length,
      hit: rs.length ? rs.filter((v) => v > 0).length / rs.length : null,
      ret: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      absret: absMine.length ? absMine.reduce((a, b) => a + b, 0) / absMine.length : null,
      base_absret: absBase.length ? absBase.reduce((a, b) => a + b, 0) / absBase.length : null,
      base_hit: bs.length ? bs.reduce((a, b) => a + b.hit, 0) / bs.length : null,
      base_ret: bs.length ? bs.reduce((a, b) => a + b.ret, 0) / bs.length : null,
    };
    if (out[hk].hit != null && out[hk].base_hit != null) {
      out[hk].edge_hit = out[hk].hit - out[hk].base_hit;
      out[hk].edge_ret = out[hk].ret - out[hk].base_ret;
    }
    if (out[hk].absret != null && out[hk].base_absret) {
      out[hk].move_ratio = out[hk].absret / out[hk].base_absret;   // 1.0 = 평균만큼 움직임
    }
  }
  return out;
}

const byMark = {};
for (const m of ['◎', '○', '△', '※']) {
  const rows = signals.filter((s) => s.mark === m);
  if (rows.length) byMark[m] = agg(rows);
}
const bySide = {
  LONG: agg(signals.filter((s) => s.side === 'LONG')),
  SHORT: agg(signals.filter((s) => s.side === 'SHORT')),
};

const track = {
  generated_at: new Date(+arg('now', Date.now())).toISOString().slice(0, 19) + 'Z',
  window: {
    from: new Date(evalTimes[0]).toISOString().slice(0, 16) + 'Z',
    to: new Date(evalTimes[evalTimes.length - 1]).toISOString().slice(0, 16) + 'Z',
    days: Math.round(((evalTimes[evalTimes.length - 1] - evalTimes[0]) / 864e5) * 10) / 10,
  },
  step_min: STEP * 5,
  symbols: symbols.length,
  evaluations: evaluated,
  signals: signals.length,
  horizons: HORIZONS.map((h) => h[0]),
  overall: agg(signals),
  by_mark: byMark,
  by_side: bySide,
  caveats: [
    '종목 풀을 현재 거래대금 상위로 골라서 생존 편향이 있다(구간 중 상장폐지된 종목은 빠져 있다).',
    '수수료·슬리피지·펀딩 지급을 반영하지 않은 총수익률이다.',
    `평가 간격이 ${STEP * 5}분이라 4h 성과는 표본이 서로 겹친다. 독립 시행이 아니다.`,
    '구간이 짧아 특정 시장 국면에 결과가 좌우된다. 국면이 바뀌면 다시 측정해야 한다.',
  ],
};

/* -------------------------------------------------------------- 출력 */

const pct = (v) => (v == null ? '   —' : (v * 100).toFixed(1) + '%');
const num = (v) => (v == null ? '   —' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');

console.log(`\n구간 ${track.window.from} ~ ${track.window.to} (${track.window.days}일)`);
console.log(`평가 ${evaluated}회 · 신호 ${signals.length}건 · 종목 ${symbols.length}개\n`);

for (const [label, rows] of [['전체', track.overall], ...Object.entries(byMark).map(([k, v]) => [k, v]),
  ['LONG', bySide.LONG], ['SHORT', bySide.SHORT]]) {
  console.log(`── ${label} (${rows.n}건)`);
  console.log('    구간    적중률   기준치    차이  |  평균수익  기준치    차이');
  for (const [hk] of HORIZONS) {
    const r = rows[hk];
    if (!r || r.n === 0) continue;
    console.log(
      `   ${hk.padEnd(5)} ${pct(r.hit)}  ${pct(r.base_hit)}  ${r.edge_hit == null ? '   —' : (r.edge_hit >= 0 ? '+' : '') + (r.edge_hit * 100).toFixed(1) + 'p'}` +
      `  |  ${num(r.ret)}  ${num(r.base_ret)}  ${num(r.edge_ret)}` +
      `  |  변동폭 ${r.absret == null ? '—' : r.absret.toFixed(2) + '%'} vs ${r.base_absret == null ? '—' : r.base_absret.toFixed(2) + '%'}` +
      ` = ${r.move_ratio == null ? '—' : r.move_ratio.toFixed(2) + '배'}`
    );
  }
  console.log('');
}
console.error(`→ ${OUT}`);

/* ---------------------------------------------------- 견고성 점검 (콘솔 전용)
 * 평가 간격보다 보유 기간이 길면 표본이 서로 겹쳐 독립 시행이 아니다.
 * n을 그대로 믿으면 없는 유의성이 생긴다. 겹침 배수로 유효 표본을 깎아 t값을 낸다.
 * 여기에 더해 '날짜별로도 같은 방향인가'를 본다. 특정 하루가 만든 결과인지 가려낸다. */
function robustness(rows, hk, h) {
  const rs = rows.map((r) => r.ret[hk]).filter((v) => v != null);
  if (rs.length < 30) return null;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1));
  const overlap = Math.max(1, h / STEP);            // 보유기간 ÷ 평가간격
  const nEff = rs.length / overlap;
  const t = m / (sd / Math.sqrt(nEff));

  const byDay = new Map();
  for (const r of rows) {
    if (r.ret[hk] == null) continue;
    const d = new Date(r.t).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r.ret[hk]);
  }
  const days = [...byDay.entries()].sort()
    .map(([d, v]) => [d, v.reduce((a, b) => a + b, 0) / v.length]);
  return { n: rs.length, nEff: Math.round(nEff), mean: m, sd, t, days };
}

/* 변동폭 배수의 유의성. 방향(부호)이 아니라 크기(|수익률|)를 맞히는지 본다.
 * 등급 간 |수익률| 평균 차이를 겹침 보정 t로 검정한다. */
function moveStat(rows, hk, h) {
  const mine = rows.map((r) => r.ret[hk]).filter((v) => v != null).map(Math.abs);
  const base = [];
  for (const r of rows) {
    const pool = baseline[`${r.t}|${hk}`];
    if (pool && pool.length) base.push(pool.reduce((a, b) => a + Math.abs(b), 0) / pool.length);
  }
  if (mine.length < 30 || base.length < 30) return null;
  const m1 = mine.reduce((a, b) => a + b, 0) / mine.length;
  const m0 = base.reduce((a, b) => a + b, 0) / base.length;
  const v1 = mine.reduce((a, b) => a + (b - m1) ** 2, 0) / (mine.length - 1);
  const overlap = Math.max(1, h / STEP);
  const nEff = mine.length / overlap;
  return { mine: m1, base: m0, ratio: m1 / m0, t: (m1 - m0) / Math.sqrt(v1 / nEff), nEff: Math.round(nEff) };
}

track.move = {};
console.log('── 변동폭 포착 유의성 (|수익률| 기준)');
for (const m of ['◎', '○', '△', '※']) {
  const rows = signals.filter((s) => s.mark === m);
  for (const [hk, h] of HORIZONS) {
    const r = moveStat(rows, hk, h);
    if (!r) continue;
    track.move[m + '|' + hk] = { ratio: r.ratio, t: r.t, n_eff: r.nEff, significant: Math.abs(r.t) >= 2 };
    if (hk === '4h') {
      console.log(`   ${m} ${hk}: ${r.mine.toFixed(2)}% vs 기준 ${r.base.toFixed(2)}% = ${r.ratio.toFixed(2)}배  ` +
        `유효n=${r.nEff}  t=${r.t.toFixed(1)} ${Math.abs(r.t) >= 2 ? '(유의)' : '(유의하지 않음)'}`);
    }
  }
}
console.log('');

track.robust = {};
console.log('── 견고성 (4h 기준)');
for (const [label, rows] of [['전체', signals], ['◎', signals.filter((s) => s.mark === '◎')]]) {
  const r = robustness(rows, '4h', 48);
  if (!r) continue;
  track.robust[label] = {
    n: r.n, n_eff: Math.round(r.nEff), mean: r.mean, sd: r.sd, t: r.t,
    significant: Math.abs(r.t) >= 2,
    days_positive: r.days.filter(([, v]) => v > 0).length,
    days_total: r.days.length,
    days: r.days.map(([d, v]) => [d, Math.round(v * 1000) / 1000]),
  };
  console.log(`   ${label}: 평균 ${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}%  표준편차 ${r.sd.toFixed(2)}%  ` +
    `n=${r.n} → 유효 n=${r.nEff}  t=${r.t.toFixed(2)} ${Math.abs(r.t) >= 2 ? '(유의)' : '(유의하지 않음)'}`);
  console.log('     날짜별: ' + r.days.map(([d, v]) =>
    `${d.slice(5)} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join('  '));
  const pos = r.days.filter(([, v]) => v > 0).length;
  console.log(`     양(+)인 날 ${pos}/${r.days.length}`);
}

// 견고성까지 담은 뒤 한 번만 쓴다. 유의성 판정을 뺀 채로 저장되는 일이 없게 하려는 것이다.
fs.writeFileSync(path.join(ROOT, '.cache/_signals.json'), JSON.stringify(signals));

track.verdict = (track.robust['◎'] && track.robust['◎'].significant)
  ? 'edge'
  : 'no-edge';
fs.mkdirSync(path.join(ROOT, path.dirname(OUT)), { recursive: true });
fs.writeFileSync(path.join(ROOT, OUT), JSON.stringify(track, null, 1));
console.error(`\n→ ${OUT}  (판정: ${track.verdict})`);
