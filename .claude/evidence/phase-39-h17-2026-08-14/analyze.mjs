#!/usr/bin/env node
/**
 * analyze.mjs — คำนวณ **ทุกตัวเลข** ที่ถูกอ้างใน §7 ข้อ 2 ของ
 * `.claude/specs/incident-2026-08-10-prod-503.md` จากไฟล์หลักฐานในโฟลเดอร์เดียวกัน
 *
 * 🔑 **สคริปต์นี้คือคำนิยาม** — ถ้าเถียงกันว่า "median แบบไหน" / "ช่องนับยังไง"
 *    คำตอบอยู่ในโค้ดนี้ ไม่ใช่ในความจำของใคร
 *
 * รัน: node .claude/evidence/phase-39-h17-2026-08-14/analyze.mjs [ไฟล์.json] [--since=ISO]
 *   · ไม่ใส่อาร์กิวเมนต์ = ไฟล์เดิม 2026-08-14 ⇒ **ตัวเลขใน §7 ข้อ 2 รันซ้ำได้เหมือนเดิมทุกตัว**
 *   · `--since=` ตัดเฉพาะ run ที่ `createdAt` **ตั้งแต่** เวลานั้นเป็นต้นไป
 *     (ใช้ตอนวัดซ้ำ: ต้องตัดที่ **เวลา merge** ไม่งั้นข้อมูลก่อน/หลังเปลี่ยนคาบปนกัน)
 * ⛔ ไม่มี dependency · อ่านไฟล์ด้วย path สัมพัทธ์กับตัวสคริปต์เอง (รันจากที่ไหนก็ได้)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const SINCE_ARG = ARGS.find((a) => a.startsWith("--since="));
const SINCE = SINCE_ARG ? Date.parse(SINCE_ARG.slice("--since=".length)) : null;
const FILE_ARG = ARGS.find((a) => !a.startsWith("--"));
const SRC = FILE_ARG
  ? path.resolve(process.cwd(), FILE_ARG)
  : path.join(HERE, "gh-runs-readiness-2026-08-14.json");
/**
 * คาบที่ **ประกาศไว้ใน workflow ตอนที่ข้อมูลชุดนั้นถูกเก็บ** (นาที) — ใช้ในข้อ [2] [5] [6]
 * 🔴 เดิมค่านี้ถูก hardcode เป็น 15 ⇒ พอเอาไปรันกับข้อมูลหลังเปลี่ยนเป็นรายชั่วโมง
 *    "ช่องที่ควรเกิด" จะถูกนับเป็น 4 เท่าของความจริง ⇒ อัตราการเกิดต่ำเกินจริง 4 เท่า
 *    (ความผิดชนิดเดียวกับทั้งเฟสนี้: เอาค่าที่ประกาศไว้ที่หนึ่ง ไปใช้กับความจริงอีกชุดหนึ่ง)
 */
const GRID_ARG = ARGS.find((a) => a.startsWith("--grid="));
const GRID = GRID_ARG ? Number(GRID_ARG.slice("--grid=".length)) : 15;

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
  .filter((r) => SINCE === null || Date.parse(r.createdAt) >= SINCE)
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

const t = sched.map((r) => Date.parse(r.createdAt));
/** gap = ระยะห่างของ `createdAt` ระหว่าง run ที่ติดกัน (นาที) · n-1 ค่า */
const gaps = [];
for (let i = 1; i < t.length; i++) gaps.push((t[i] - t[i - 1]) / 60000);

console.log("=".repeat(72));
console.log(`§7 ข้อ 2 — ตัวเลขทั้งหมด (source: ${path.basename(SRC)}${SINCE_ARG ? " " + SINCE_ARG : ""})`);
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
const gridSlots = [];
for (let m = 0; m < 60; m += GRID) gridSlots.push(m);
const grid = Object.fromEntries(gridSlots.map((m) => [m, 0]));
for (const m of minutes) if (m in grid) grid[m]++;
const onGrid = Object.values(grid).reduce((a, b) => a + b, 0);
const gridExpected = (sched.length * gridSlots.length) / 60;
// นาทีบนหน้าปัดเขียนสองหลักเสมอ — `:0` อ่านเหมือนกริดคนละอันกับ `:00`
const gridLabel = gridSlots.map((m) => `:${String(m).padStart(2, "0")}`).join("/");
console.log(`\n[2] createdAt ตกบนกริดของคาบที่ประกาศไว้ (${GRID} นาที: ${gridLabel})`);
console.log(`  นับได้                   : ${onGrid} ใบ  (${JSON.stringify(grid)})`);
console.log(`  คาดจากการสุ่มล้วน        : ${sched.length} x ${gridSlots.length}/60 = ${gridExpected.toFixed(2)}`);
console.log(`  => ${onGrid < gridExpected ? "ต่ำกว่าค่าสุ่ม" : "ไม่ต่ำกว่าค่าสุ่ม"} ⇒ ไม่มีร่องรอยกริด`);

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
console.log(`  gap < ${2 * GRID} นาที (2 คาบ)      : ${gaps.filter((g) => g < 2 * GRID).length} ครั้ง`);

// ── 5. ร่องรอยของกริด 15 นาทีใน gap ─────────────────────────────────────────
const nearGrid = gaps.filter((g) => { const m = g % GRID; return m <= 1 || m >= GRID - 1; }).length;
console.log(`\n[5] gap ที่ mod ${GRID} ใกล้ 0 (+-1 นาที)`);
console.log(`  นับได้                   : ${nearGrid}/${gaps.length} = ${(100 * nearGrid / gaps.length).toFixed(1)}%`);
console.log(`  คาดจากการสุ่มล้วน        : 2/${GRID} = ${(200 / GRID).toFixed(1)}%`);

// ── 6. อัตราการเกิด + การทดสอบ "ดรอปสุ่มอิสระ" ──────────────────────────────
// ช่องของ cron ที่ควรเกิดตามคาบที่ประกาศไว้ = นับปลายทั้งสองข้าง: floor(ชม. x 60/GRID) + 1
const slotsPerHour = 60 / GRID;
const slots = Math.floor(windowHours * slotsPerHour) + 1;
const p = sched.length / slots;
console.log("\n[6] อัตราการเกิด และการทดสอบสมมติฐาน 'ดรอปแบบสุ่มอิสระ'");
console.log(`  ช่องที่ควรเกิด           : floor(${windowHours.toFixed(2)} x ${slotsPerHour}) + 1 = ${slots}  (นับปลายทั้งสองข้าง)`);
console.log(`  อัตราเกิดจริง p          : ${sched.length}/${slots} = ${(100 * p).toFixed(1)}%`);
const expectedAdjacent = slots * p * p;
// "ช่องติดกันรอดทั้งคู่" = gap สั้นกว่าสองคาบ (ผูกกับ GRID ไม่ใช่ค่า 30 ที่ตายตัว)
const actualAdjacent = gaps.filter((g) => g < 2 * GRID).length;
/**
 * เกณฑ์อ่านผลของข้อ [6]: ของจริงห่างจากค่าที่คาดกี่เท่า ถึงจะเรียกว่า "ไม่ใช่การดรอปแบบสุ่ม"
 *
 * 🔴 บรรทัดสรุปของข้อนี้เคยเป็น **string ตายตัว** — พิมพ์ว่า "ไม่ใช่การดรอปแบบสุ่ม" เสมอ
 *    ไม่ว่าตัวเลขสองบรรทัดบนจะบอกอะไร ⇒ กับชุดรายชั่วโมง (คาด 11.0 · จริง 10) มัน **ตรงกัน**
 *    แต่สคริปต์ยังพิมพ์ว่าไม่ใช่การสุ่ม ⇒ ข้อสรุปที่ไม่ได้ derive จากตัวเลขของตัวเอง
 *    ⛔ ไฟล์นี้ประกาศตัวเองว่า "คือคำนิยาม" ⇒ ห้ามมีบรรทัดสรุปที่ตัวเลขไม่รองรับ
 *
 * ทำไม 2×: ชุด 2026-08-14 ห่างกัน 18.0 vs 0 · ชุดรายชั่วโมงห่างกัน 11.0 vs 10 (1.1 เท่า)
 * ⇒ เกณฑ์ค่าใดก็ตามระหว่าง ~1.2 ถึง ~10 ให้คำตอบเดียวกันทั้งสองชุด — 2 คือค่ากลางที่อ่านง่าย
 * ⛔ นี่เป็น **เกณฑ์การอ่านผล ไม่ใช่การทดสอบนัยสำคัญทางสถิติ** — ห้ามอ้างเป็น p-value
 */
const RANDOM_DROP_DIVERGENCE_FACTOR = 2;
const diverges =
  actualAdjacent === 0
    ? expectedAdjacent >= RANDOM_DROP_DIVERGENCE_FACTOR
    : Math.max(expectedAdjacent / actualAdjacent, actualAdjacent / expectedAdjacent) >=
      RANDOM_DROP_DIVERGENCE_FACTOR;
const dropVerdict = diverges
  ? `=> ต่างจากค่าที่คาด >= ${RANDOM_DROP_DIVERGENCE_FACTOR} เท่า => ไม่ใช่การดรอปแบบสุ่ม`
  : `=> ใกล้เคียงค่าที่คาด (< ${RANDOM_DROP_DIVERGENCE_FACTOR} เท่า) => สอดคล้องกับการไม่มีการดรอปเลย`;
console.log(`  ถ้าดรอปสุ่มอิสระ: ช่องติดกันรอดทั้งคู่ = ${slots} x p^2 = ${expectedAdjacent.toFixed(1)} ครั้ง`);
console.log(`  ของจริง (gap < ${2 * GRID} นาที)  : ${actualAdjacent} ครั้ง  ${dropVerdict}`);

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
// ไม่มี failure เลย = 0.0% ไม่ใช่ NaN — `undefined / n` ทำให้บรรทัดนี้อ่านเหมือนคำนวณพลาด
const failurePct = sched.length === 0 ? "—" : ((100 * (con.failure ?? 0)) / sched.length).toFixed(1) + "%";
console.log(`\n[9] conclusion: ${JSON.stringify(con)}  (failure = ${failurePct})`);

// ── 10. จับคู่ข้อความ Discord 4 ใบกับ run จริง ──────────────────────────────
/**
 * 🔴 ส่วนนี้เคย **ไม่เคารพ `--since`** — `byId` สร้างจาก `all` ที่ยังไม่กรอง
 *    ⇒ output ที่หัวเรื่องเขียนว่า `--since=2026-08-14T18:01:49Z` กลับพิมพ์ run ของ
 *      `2026-08-13T23:48Z` … `2026-08-14T05:58Z` ซึ่ง **อยู่นอกหน้าต่างทั้งหมด**
 *    ⇒ = รายงานหลักฐานเก่าใต้หัวข้อของใหม่ · ความผิดชนิดเดียวกับที่ทั้งเฟสนี้พยายามเลิกทำ
 *
 * ข้อความ Discord 4 ใบนี้ **ผูกกับชุดข้อมูล 2026-08-14 โดยเฉพาะ** (id ของ run ตายตัว)
 * ⇒ พอมีการกรองหน้าต่าง การจับคู่นี้ไม่มีความหมาย ⇒ **ข้ามทั้ง section แล้วบอกว่าทำไม**
 * ⛔ ห้ามพิมพ์ run ที่อยู่นอกหน้าต่างที่กรองไว้ ไม่ว่ากรณีใด
 */
if (SINCE !== null) {
  console.log("\n[10] ข้าม — การจับคู่ Discord ผูกกับชุด 2026-08-14 · ไม่อยู่ในหน้าต่างที่กรอง");
} else {
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
}

// ── 11. เกณฑ์ที่ประกาศไว้ในโค้ด vs ข้อมูลชุดนี้ ─────────────────────────────
/**
 * 🔑 ส่วนนี้ตอบคำถามเดียว: **เกณฑ์ที่เราเพิ่งประกาศ จะยิงกี่ครั้งกับข้อมูลชุดนี้**
 * ค่าคงที่ต้องตรงกับโค้ดจริง — ที่มาเขียนกำกับไว้ทุกตัว ⛔ ห้ามแก้ให้ผลออกมาสวย
 *   · `CRON_INTERVAL_MINUTES = 60`            (`src/lib/readiness-verdict.ts`)
 *   · `detectGap` gapped เมื่อ floor(gap/60) - 1 >= 1  ⇒ **gap >= 120 นาที**
 *   · `STALE_TOLERANCE_FACTOR = 3`            (`src/lib/heartbeat.ts`) ⇒ stale เมื่อ **gap >= 180 นาที**
 */
const CRON_INTERVAL_MINUTES = 60;
const STALE_TOLERANCE_FACTOR = 3;
const GAP_THRESHOLD = CRON_INTERVAL_MINUTES * 2; // 120
const STALE_THRESHOLD = CRON_INTERVAL_MINUTES * STALE_TOLERANCE_FACTOR; // 180
const gapFires = gaps.filter((g) => g >= GAP_THRESHOLD).length;
const staleFires = gaps.filter((g) => g >= STALE_THRESHOLD).length;
const maxGap = sortedGaps[sortedGaps.length - 1];
console.log("\n[11] เกณฑ์ที่ประกาศไว้ในโค้ด vs ข้อมูลชุดนี้");
console.log(`  ขนาดตัวอย่าง             : ${gaps.length} gap จาก ${sched.length} run · หน้าต่าง ${windowHours.toFixed(2)} ชม.`);
console.log(`  detectGap ยิง (gap >= ${GAP_THRESHOLD})  : ${gapFires}/${gaps.length} = ${gaps.length ? (100 * gapFires / gaps.length).toFixed(1) : "—"}%`);
console.log(`  WATCHER_LATE (gap >= ${STALE_THRESHOLD}) : ${staleFires}/${gaps.length} = ${gaps.length ? (100 * staleFires / gaps.length).toFixed(1) : "—"}%`);
console.log(`  max gap                  : ${f1(maxGap)} นาที = ${(maxGap / 60).toFixed(2)} ชม.`);
console.log(`  margin ถึงเกณฑ์ stale     : ${f1(STALE_THRESHOLD - maxGap)} นาที`);
console.log(`  ⚠️ หน้าต่างสั้น ⇒ ตัวเลขนี้เป็น **ขอบเขตบนของสิ่งที่ยืนยันได้** ไม่ใช่อัตราระยะยาว`);

console.log("\n" + "=".repeat(72));
