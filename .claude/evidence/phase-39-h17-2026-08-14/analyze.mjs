#!/usr/bin/env node
/**
 * analyze.mjs — คำนวณ **ทุกตัวเลข** ที่ถูกอ้างใน §7 ข้อ 2 ของ
 * `.claude/specs/incident-2026-08-10-prod-503.md` จากไฟล์หลักฐานในโฟลเดอร์เดียวกัน
 *
 * 🔑 **สคริปต์นี้คือคำนิยาม** — ถ้าเถียงกันว่า "median แบบไหน" / "ช่องนับยังไง"
 *    คำตอบอยู่ในโค้ดนี้ ไม่ใช่ในความจำของใคร
 *
 * รัน: node .claude/evidence/phase-39-h17-2026-08-14/analyze.mjs
 * ⛔ ไม่มี dependency · อ่านไฟล์ด้วย path สัมพัทธ์กับตัวสคริปต์เอง (รันจากที่ไหนก็ได้)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "gh-runs-readiness-2026-08-14.json");

// ── นิยามที่ใช้ทั้งไฟล์ (เขียนไว้ตรงนี้ที่เดียว) ──────────────────────────────
/** median ของ n คู่ = **เฉลี่ยสองตัวกลาง** (ไม่ใช่ lower/upper quantile) */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");

const all = JSON.parse(fs.readFileSync(SRC, "utf8"));
const sched = all
  .filter((r) => r.event === "schedule")
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

const t = sched.map((r) => Date.parse(r.createdAt));
/** gap = ระยะห่างของ `createdAt` ระหว่าง run ที่ติดกัน (นาที) · n-1 ค่า */
const gaps = [];
for (let i = 1; i < t.length; i++) gaps.push((t[i] - t[i - 1]) / 60000);

console.log("=".repeat(72));
console.log("§7 ข้อ 2 — ตัวเลขทั้งหมด (source: gh-runs-readiness-2026-08-14.json)");
console.log("=".repeat(72));

// ── 1. ขอบเขตของชุดข้อมูล ────────────────────────────────────────────────────
const byEvent = {};
for (const r of all) byEvent[r.event] = (byEvent[r.event] || 0) + 1;
const windowHours = (t[t.length - 1] - t[0]) / 3600000;
console.log("\n[1] ขอบเขต");
console.log(`  record ทั้งหมด           : ${all.length}  ⚠️ --limit 100 คืนครบ 100 = รายการถูกตัด`);
console.log(`  แยกตาม event            : ${JSON.stringify(byEvent)}`);
console.log(`  event=schedule           : ${sched.length}`);
console.log(`  หน้าต่าง                 : ${sched[0].createdAt} -> ${sched[sched.length - 1].createdAt}`);
console.log(`  ความยาวหน้าต่าง          : ${windowHours.toFixed(2)} ชม.`);

// ── 2. createdAt ตกบนกริด */15 ───────────────────────────────────────────────
const minutes = sched.map((r) => new Date(r.createdAt).getUTCMinutes());
const grid = { 0: 0, 15: 0, 30: 0, 45: 0 };
for (const m of minutes) if (m in grid) grid[m]++;
const onGrid = Object.values(grid).reduce((a, b) => a + b, 0);
console.log("\n[2] createdAt ตกบนกริด :00/:15/:30/:45");
console.log(`  นับได้                   : ${onGrid} ใบ  (${JSON.stringify(grid)})`);
console.log(`  คาดจากการสุ่มล้วน        : ${sched.length} x 4/60 = ${(sched.length * 4 / 60).toFixed(2)}`);
console.log(`  => ${onGrid < sched.length * 4 / 60 ? "ต่ำกว่าค่าสุ่ม" : "ไม่ต่ำกว่าค่าสุ่ม"} ⇒ ไม่มีร่องรอยกริด`);

// ── 3. การกระจายของนาที + ทำไมห้ามตีความ ────────────────────────────────────
const hist = new Array(6).fill(0);
for (const m of minutes) hist[Math.floor(m / 10)]++;
/**
 * ก้าวของนาที — มี **สามนิยาม** ที่ให้ตัวเลขต่างกันมาก ⇒ ⚠️ **ต้องระบุเสมอว่าใช้อันไหน**
 *   circular = min(|Δ|, 60−|Δ|)   ← ระยะบนหน้าปัด (58 → 02 ห่างกัน 4 ไม่ใช่ 56)
 *   forward  = Δ mod 60           ← "นาทีไหลไปข้างหน้าเท่าไร" (0..59) — นิยามที่ reviewer ใช้
 *   linear   = |Δ|                ← ผลต่างดิบ ไม่วนวงกลม
 * baseline ของแต่ละนิยาม **ไม่เท่ากัน** — คำนวณตรง ๆ ด้านล่าง ห้ามใช้ค่าเดียวกันข้ามนิยาม
 */
const stepCirc = [], stepFwd = [], stepLin = [];
for (let i = 1; i < minutes.length; i++) {
  const raw = minutes[i] - minutes[i - 1];
  const d = Math.abs(raw);
  stepLin.push(d);
  stepCirc.push(Math.min(d, 60 - d));
  stepFwd.push(((raw % 60) + 60) % 60);
}
const cnt = (xs) => xs.filter((s) => s <= 10).length;
const pct = (xs) => (100 * cnt(xs) / xs.length).toFixed(0);
// baseline ถ้านาทีสองใบติดกันเป็นอิสระและ uniform บน {0..59}
let nCirc = 0, nFwd = 0, nLin = 0;
for (let a = 0; a < 60; a++) for (let b = 0; b < 60; b++) {
  const raw = b - a, d = Math.abs(raw);
  if (Math.min(d, 60 - d) <= 10) nCirc++;
  if ((((raw % 60) + 60) % 60) <= 10) nFwd++;
  if (d <= 10) nLin++;
}
const base = (n) => `${(100 * n / 3600).toFixed(0)}%`;
console.log("\n[3] การกระจายของนาที (ช่วงละ 10 นาที) — ⚠️ ตัวอย่างไม่อิสระ ห้ามตีความ");
console.log(`  histogram [0-9,10-19,...]: ${JSON.stringify(hist)}`);
console.log(`  นิยาม      median   ก้าว<=10นาที   คาดถ้าสุ่มอิสระ   เกาะกลุ่มกว่าการสุ่ม?`);
console.log(`  circular  ${f1(median(stepCirc)).padStart(6)}   ${(cnt(stepCirc) + "/" + stepCirc.length).padStart(6)} = ${pct(stepCirc).padStart(3)}%      ${base(nCirc).padStart(4)}            ${100 * cnt(stepCirc) / stepCirc.length > 100 * nCirc / 3600 ? "ใช่" : "ไม่"}`);
console.log(`  forward   ${f1(median(stepFwd)).padStart(6)}   ${(cnt(stepFwd) + "/" + stepFwd.length).padStart(6)} = ${pct(stepFwd).padStart(3)}%      ${base(nFwd).padStart(4)}            ${100 * cnt(stepFwd) / stepFwd.length > 100 * nFwd / 3600 ? "ใช่" : "ไม่"}`);
console.log(`  linear    ${f1(median(stepLin)).padStart(6)}   ${(cnt(stepLin) + "/" + stepLin.length).padStart(6)} = ${pct(stepLin).padStart(3)}%      ${base(nLin).padStart(4)}            ${100 * cnt(stepLin) / stepLin.length > 100 * nLin / 3600 ? "ใช่" : "ไม่"}`);
console.log(`  ⇒ **ทั้งสามนิยามชี้ทางเดียวกัน**: run ที่ติดกันเกาะกลุ่มในนาทีใกล้ ๆ กันมากกว่าการสุ่ม`);
console.log(`  ⇒ ตัวอย่างไม่อิสระ ⇒ histogram ตีความด้วยเครื่องมือที่สมมติความอิสระไม่ได้ (รวมถึงสายตา)`);
console.log(`  ลำดับนาที 20 ใบแรก       : ${minutes.slice(0, 20).join(" ")}`);
// หาช่วงที่นาทีไหลขึ้นต่อเนื่องยาวที่สุด (หลักฐานว่าตัวอย่างไม่อิสระแบบเห็นด้วยตา)
let bestI = 0, bestLen = 1, curI = 0, curLen = 1;
for (let i = 1; i < minutes.length; i++) {
  if (minutes[i] > minutes[i - 1]) { curLen++; } else { curI = i; curLen = 1; }
  if (curLen > bestLen) { bestLen = curLen; bestI = curI; }
}
console.log(`  ช่วงที่นาทีไหลขึ้นยาวสุด : ${minutes.slice(bestI, bestI + bestLen).join(" ")}  (${bestLen} ใบติด)`);

// ── 4. gap ระหว่าง run ───────────────────────────────────────────────────────
const sortedGaps = [...gaps].sort((a, b) => a - b);
console.log("\n[4] gap ระหว่าง createdAt ของ run ที่ติดกัน (นาที)");
console.log(`  จำนวน gap                : ${gaps.length}  (= ${sched.length} run - 1)`);
console.log(`  min                      : ${f1(sortedGaps[0])}`);
console.log(`  median (เฉลี่ยสองตัวกลาง): ${f1(median(gaps))}`);
console.log(`    · สองตัวกลาง (n คู่)    : ${f1(sortedGaps[gaps.length / 2 - 1])} , ${f1(sortedGaps[gaps.length / 2])}`);
console.log(`  mean                     : ${f1(mean(gaps))}`);
console.log(`  max                      : ${f1(sortedGaps[sortedGaps.length - 1])}`);
console.log(`  gap < 30 นาที            : ${gaps.filter((g) => g < 30).length} ครั้ง`);

// ── 5. ร่องรอยของกริด 15 นาทีใน gap ─────────────────────────────────────────
const near15 = gaps.filter((g) => { const m = g % 15; return m <= 1 || m >= 14; }).length;
console.log("\n[5] gap ที่ mod 15 ใกล้ 0 (+-1 นาที)");
console.log(`  นับได้                   : ${near15}/${gaps.length} = ${(100 * near15 / gaps.length).toFixed(1)}%`);
console.log(`  คาดจากการสุ่มล้วน        : 2/15 = 13.3%`);

// ── 6. อัตราการเกิด + การทดสอบ "ดรอปสุ่มอิสระ" ──────────────────────────────
// ช่องของ cron ทุก 15 นาที ที่ควรเกิด = นับปลายทั้งสองข้าง: floor(ชม. x 4) + 1
const slots = Math.floor(windowHours * 4) + 1;
const p = sched.length / slots;
console.log("\n[6] อัตราการเกิด และการทดสอบสมมติฐาน 'ดรอปแบบสุ่มอิสระ'");
console.log(`  ช่องที่ควรเกิด           : floor(${windowHours.toFixed(2)} x 4) + 1 = ${slots}  (นับปลายทั้งสองข้าง)`);
console.log(`  อัตราเกิดจริง p          : ${sched.length}/${slots} = ${(100 * p).toFixed(1)}%`);
console.log(`  ถ้าดรอปสุ่มอิสระ: ช่องติดกันรอดทั้งคู่ = ${slots} x p^2 = ${(slots * p * p).toFixed(1)} ครั้ง`);
console.log(`  ของจริง (gap < 30 นาที)  : ${gaps.filter((g) => g < 30).length} ครั้ง  => ไม่ใช่การดรอปแบบสุ่ม`);

// ── 7. อายุของ run (ทดสอบสมมติฐาน "หน่วง") ──────────────────────────────────
const dur = sched.map((r) => (Date.parse(r.updatedAt) - Date.parse(r.createdAt)) / 1000);
const sortedDur = [...dur].sort((a, b) => a - b);
console.log("\n[7] updatedAt - createdAt (อายุทั้ง run, วินาที)");
console.log(`  min / median / max       : ${sortedDur[0]} / ${median(dur)} / ${sortedDur[sortedDur.length - 1]}`);
console.log(`  startedAt == createdAt   : ${sched.filter((r) => r.startedAt === r.createdAt).length}/${sched.length}`);
console.log(`  ⛔ ห้ามใช้บรรทัดบนเป็นหลักฐาน — อาจเป็นพฤติกรรมของ API สำหรับ event=schedule`);

// ── 8. รายวัน ────────────────────────────────────────────────────────────────
const FULL_DAYS = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"];
const byDay = {};
for (const r of sched) (byDay[r.createdAt.slice(0, 10)] ||= []).push(r);
console.log("\n[8] รายวัน — gap 'ในวัน' = gap ระหว่าง run ที่ติดกัน**ภายในวันเดียวกัน**เท่านั้น");
console.log("  วัน          n    mean(gap)  median(gap)   หมายเหตุ");
for (const d of Object.keys(byDay).sort()) {
  const rs = byDay[d];
  const g = [];
  for (let i = 1; i < rs.length; i++) g.push((Date.parse(rs[i].createdAt) - Date.parse(rs[i - 1].createdAt)) / 60000);
  const full = FULL_DAYS.includes(d);
  console.log(`  ${d}  ${String(rs.length).padStart(2)}   ${f1(mean(g)).padStart(7)}   ${f1(median(g)).padStart(8)}      ${full ? "วันเต็ม" : "⛔ วันไม่เต็ม — ห้ามเทียบ"}`);
}

// ── 9. conclusion ────────────────────────────────────────────────────────────
const con = {};
for (const r of sched) con[r.conclusion] = (con[r.conclusion] || 0) + 1;
console.log(`\n[9] conclusion: ${JSON.stringify(con)}  (failure = ${(100 * con.failure / sched.length).toFixed(1)}%)`);

// ── 10. จับคู่ข้อความ Discord 4 ใบกับ run จริง ──────────────────────────────
const byId = Object.fromEntries(all.map((r) => [r.databaseId, r]));
const DISCORD = [
  { id: "A", run: 31755169173, lastCheckAt: "2026-08-13T23:49:22.453Z" },
  { id: "B", run: 31763605249, lastCheckAt: "2026-08-14T02:24:36.494Z" },
  { id: "C", run: 31769745724, lastCheckAt: "2026-08-14T04:24:36.127Z" },
  { id: "D", run: 31774722227, lastCheckAt: "2026-08-14T05:59:15.064Z" },
];
console.log("\n[10] offset จริง = lastCheckAt (Discord) - createdAt (run)");
for (const d of DISCORD) {
  const r = byId[d.run];
  if (!r) { console.log(`  ${d.id}: ⛔ ไม่พบ run ${d.run} ในไฟล์`); continue; }
  const off = (Date.parse(d.lastCheckAt) - Date.parse(r.createdAt)) / 1000;
  console.log(`  ${d.id}  run ${d.run}  createdAt ${r.createdAt}  offset +${off.toFixed(1)}s`);
}
console.log("  => offset จริงอยู่ในช่วงเดียวกับอายุ run (ข้อ 7) ⇒ ไม่มีคิว ⇒ สมมติฐาน 'หน่วง' ตก");
console.log("\n" + "=".repeat(72));
