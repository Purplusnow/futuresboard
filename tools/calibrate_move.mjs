/* 예상 변동폭 추정치를 실측으로 보정한다.
 *
 * 추정식은 ATR(5m,14)을 4시간(48봉)으로 확장한 것이다.
 *     예상 |4h 변동| = atr_pct × √48 × K
 * ATR은 봉의 '범위'라서 종가-종가 순변동보다 크다. K가 그 차이를 흡수한다.
 *
 * K를 눈대중으로 정하면 화면에 찍히는 숫자가 근거 없는 값이 된다. 그래서
 * 리플레이가 남긴 실제 신호(.cache/_signals.json)로 맞추고, 맞췄다는 사실만이 아니라
 * '얼마나 잘 맞는지'까지 함께 낸다 — 십분위별로 단조로운지 보면 추정치가
 * 순서를 지키는지 알 수 있다.
 *
 * 사용법: node tools/calibrate_move.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCALE = Math.sqrt(48);            // 5분봉 → 4시간

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache/_signals.json'), 'utf8'));
const rows = raw.filter((r) => r.atr > 0 && r.ret && r.ret['4h'] != null)
  .map((r) => ({ pred0: r.atr * SCALE, real: Math.abs(r.ret['4h']), mark: r.mark }));

console.log(`표본 ${rows.length.toLocaleString()}건`);

const meanReal = rows.reduce((a, r) => a + r.real, 0) / rows.length;
const meanPred0 = rows.reduce((a, r) => a + r.pred0, 0) / rows.length;
const K = meanReal / meanPred0;
console.log(`\n실측 평균 |4h| ${meanReal.toFixed(3)}%  ·  보정 전 추정 평균 ${meanPred0.toFixed(3)}%`);
console.log(`→ K = ${K.toFixed(4)}`);

// 십분위 — 추정치가 순서를 지키는가. 값이 맞는 것보다 순서가 맞는 게 스크리너엔 더 중요하다.
const sorted = rows.slice().sort((a, b) => a.pred0 - b.pred0);
const bins = 10, size = Math.floor(sorted.length / bins);
console.log('\n십분위  예상변동    실측 |4h|    비율');
let prev = null, monotonic = true;
for (let i = 0; i < bins; i++) {
  const chunk = sorted.slice(i * size, i === bins - 1 ? sorted.length : (i + 1) * size);
  const p = chunk.reduce((a, r) => a + r.pred0 * K, 0) / chunk.length;
  const r = chunk.reduce((a, x) => a + x.real, 0) / chunk.length;
  if (prev != null && r < prev) monotonic = false;
  prev = r;
  console.log(`  D${String(i + 1).padStart(2)}   ${p.toFixed(2).padStart(6)}%   ${r.toFixed(2).padStart(7)}%   ${(r / p).toFixed(2)}배`);
}
console.log(monotonic ? '\n✓ 십분위 실측이 단조 증가 — 추정치가 순서를 지킨다'
                      : '\n✗ 단조성 깨짐 — 추정치가 순서를 못 지킨다');

// 순위상관(스피어만). 절대값보다 순서를 얼마나 지키는지가 핵심이다.
function spearman(a, b) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(arr.length);
    idx.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - ma);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - ma) ** 2;
  }
  return num / Math.sqrt(da * db);
}
const rho = spearman(rows.map((r) => r.pred0), rows.map((r) => r.real));
console.log(`순위상관(스피어만) ρ = ${rho.toFixed(3)}`);

// 등급별로도 K가 크게 다르면 등급마다 보정이 필요하다는 뜻이다
console.log('\n등급별 실측/추정 비율');
for (const m of ['◎', '○', '△', '※']) {
  const g = rows.filter((r) => r.mark === m);
  if (g.length < 50) continue;
  const p = g.reduce((a, r) => a + r.pred0 * K, 0) / g.length;
  const r = g.reduce((a, x) => a + x.real, 0) / g.length;
  console.log(`  ${m}  n=${String(g.length).padStart(6)}  예상 ${p.toFixed(2)}%  실측 ${r.toFixed(2)}%  ${(r / p).toFixed(2)}배`);
}

console.log(`\nconfig.js 에 넣을 값:  MOVE_K: ${K.toFixed(4)}`);
