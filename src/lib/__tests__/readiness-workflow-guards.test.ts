/**
 * src/lib/__tests__/readiness-workflow-guards.test.ts
 * Phase 39 — ค้ำ **กฎเชิงโครงสร้าง** ของ `.github/workflows/readiness.yml` (erratum §H-12)
 *
 * ทำไมต้องมีไฟล์นี้: §H-12 มีกฎที่ *"ห้ามตัดออกข้อใดข้อหนึ่ง"* หลายข้อ (concurrency 2 ชั้นอิสระ ·
 * dispatcher ห้ามรอผล · ผู้ตรวจต้องไม่ใช่ชิ้นส่วนเดียวกับผู้ถูกตรวจ) แต่ทั้งหมด **ถูกเฝ้าด้วยคอมเมนต์**
 * ⇒ คนถัดไปย้าย `concurrency` กลับขึ้นระดับ workflow ได้เงียบ ๆ แล้ว CI ยังเขียว
 * ⇒ **คลาสเดียวกับ §G ข้อ 13** (ค่าเดียวกันถูกคัดลอกไว้หลายที่โดยไม่มีอะไรผูก) ซึ่งเพิ่งกัดเฟสนี้มาแล้ว
 *
 * ใช้แพตเทิร์นเดียวกับ `readiness-cadence.test.ts` § "สนามที่สาม" — YAML ผูกด้วย import ไม่ได้
 * จึงต้องอ่านไฟล์แล้วเทียบด้วย test
 *
 * ⚠️ **กฎการเขียน assertion ในไฟล์นี้: ค้ำ "พฤติกรรม" ไม่ใช่ "ถ้อยคำ"**
 *    · ห้ามค้ำชื่อ concurrency group (เปลี่ยนชื่อได้ ตราบใดที่ยัง **ต่างกัน**)
 *    · ห้าม match กับข้อความในคอมเมนต์ — yml มีบรรทัด "⛔ ห้าม --watch" อยู่ในคอมเมนต์
 *      ⇒ **strip คอมเมนต์ก่อน match เสมอ** ไม่งั้น test จะแดงเพราะคำเตือนของตัวเอง
 *
 * 🔴 **สิ่งที่ไฟล์นี้ค้ำไม่ได้ — เขียนไว้เพราะ test ที่ดูครบแต่ไม่ครบ อันตรายกว่าไม่มี test:**
 *    "dispatcher ห้ามรอผล" **ไม่มีทางค้ำครบด้วย static check** — วิธีรอมีไม่จำกัดรูป
 *    (loop `gh api` เอง · `sleep 600` เฉย ๆ · `curl` poll เอง · recursion)
 *    ⇒ ที่นี่ค้ำได้แค่ **รูปที่รู้จัก** (A: loop ไม่มีเพดาน · B: การไปแตะผลลัพธ์ของ run)
 *    ⇒ เพดานตัวจริงคือ `timeout-minutes` ของ job `dispatch` ซึ่ง **GitHub บังคับตอนรัน ไม่ใช่ CI**
 *      (ข้อ C ด้านล่าง) — เป็นชั้นเดียวที่ไม่ถูกลบพร้อมไฟล์นี้
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

const WORKFLOW_PATH = ".github/workflows/readiness.yml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
}
interface WorkflowJob {
  concurrency?: { group?: string };
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps: WorkflowStep[];
}
interface Workflow {
  concurrency?: unknown;
  jobs: Record<string, WorkflowJob>;
}

const workflow = load(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;

/**
 * ตัดคอมเมนต์ของ shell ออกจากสคริปต์ก่อนนำไป match
 *
 * 🔑 จำเป็นจริง ไม่ใช่ความระมัดระวังเกินเหตุ: `run:` ของ job `dispatch` มีบรรทัด
 * `# ⛔ ชั้น ก: ห้ามรอผล — ห้าม --watch` อยู่ ⇒ ถ้าไม่ตัดคอมเมนต์ test จะแดงทันที
 * **โดยที่ไม่มีใครทำผิด** = ค้ำผิดชั้น (ค้ำถ้อยคำแทนพฤติกรรม)
 *
 * ⚠️ **ข้อจำกัดที่รู้ตัว (ไม่ใช่ของที่มองข้าม):** ฟังก์ชันนี้ตัด **ทุกอย่างหลัง `#`**
 *    รวมถึง `#` ที่อยู่ใน string ของ shell เอง — เช่น `echo "run #$id status"`
 *    จะถูกตัดเหลือ `echo "run ` ⇒ คำว่า `status` หายไปจากสิ่งที่ guard เห็น
 *
 *    🔑 **ทิศทางของ error สำคัญกว่าตัว error:** ผลคือ guard **เงียบลง ไม่ใช่ดังขึ้น**
 *    ⇒ เสี่ยงเป็น **false negative** (ปล่อยของผิดผ่าน) ไม่ใช่ false positive (แดงทั้งที่ถูก)
 *    ⇒ ยอมรับได้ **เฉพาะเพราะ** ชั้น C (`timeout-minutes`) ไม่ได้พึ่งการ parse นี้เลย
 *      — ถ้าวันหนึ่ง C ถูกถอดออก ข้อจำกัดนี้จะกลายเป็นรูจริง ไม่ใช่รูที่รับได้อีกต่อไป
 *    ⛔ อย่า "แก้" ด้วย regex ที่ฉลาดขึ้นเพื่อเข้าใจ quoting ของ shell — parser ครึ่งใบ
 *      ที่ดูน่าเชื่อถือกว่า อันตรายกว่าอันนี้ที่รู้ขอบเขตตัวเอง
 */
function stripShellComments(script: string): string {
  return script
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
}

function runScriptsOf(jobName: string): string[] {
  return workflow.jobs[jobName].steps
    .map((s) => s.run)
    .filter((r): r is string => typeof r === "string")
    .map(stripShellComments);
}

describe("§H-12 — โครงสร้างของ readiness.yml ที่ห้ามถูกรื้อเงียบ ๆ", () => {
  it("มี job ครบสองตัว: `dispatch` และ `check`", () => {
    // ค้ำสมมติฐานของ test ทุกข้อด้านล่าง — ถ้า job ถูกเปลี่ยนชื่อ/ยุบรวม
    // ต้องมาทบทวนไฟล์นี้ทั้งไฟล์ ไม่ใช่ให้ test อื่นเงียบไปเฉย ๆ
    expect(Object.keys(workflow.jobs).sort()).toEqual(["check", "dispatch"]);
  });

  // ── ข้อกำหนด 3: concurrency 2 ชั้นอิสระ ────────────────────────────────
  it("ไม่มี `concurrency` ที่ระดับ workflow", () => {
    // ถ้าอยู่ระดับ workflow ⇒ run ของ `dispatch` กับ run ที่มันสั่งแย่ง slot เดียวกัน
    // ⇒ ชั้น ข ของกฎกัน deadlock หายไปทั้งชั้น (§H-12 ความเสี่ยงข้อ 1)
    expect(workflow.concurrency).toBeUndefined();
  });

  it("`dispatch` กับ `check` อยู่คนละ concurrency group", () => {
    const dispatchGroup = workflow.jobs.dispatch.concurrency?.group;
    const checkGroup = workflow.jobs.check.concurrency?.group;

    // ทั้งคู่ต้อง "มี" — group ที่หายไปหนึ่งข้าง = ไม่มีการกันชนอีกต่อไป
    expect(dispatchGroup).toBeTruthy();
    expect(checkGroup).toBeTruthy();

    // 🔑 ค้ำ **ความต่าง** ไม่ใช่ชื่อ — เปลี่ยนชื่อ group ได้อิสระตราบใดที่ยังแยกกันอยู่
    expect(dispatchGroup).not.toBe(checkGroup);
  });

  // ── ข้อกำหนด 4-A: loop ต้องมีเพดาน ────────────────────────────────────
  it("A — สคริปต์ใน `dispatch` ไม่มี loop แบบไม่มีเพดาน (`while` / `until`)", () => {
    // regression ที่คาดไว้: คนถัดไปเปลี่ยน `for i in 1 2 3` เป็น `while true`
    // เพราะอยาก "ให้ชัวร์กว่าเดิม" ⇒ กลายเป็นการรอผล = ชนกฎชั้น ก ที่แบบตั้งไว้
    for (const script of runScriptsOf("dispatch")) {
      expect(script).not.toMatch(/\b(while|until)\b/);
    }
  });

  // ── ข้อกำหนด 4-B: ห้ามแตะ "ผล" ของ run ────────────────────────────────
  it("B — สคริปต์ใน `dispatch` ไม่อ่านผลลัพธ์ของ run (`--watch` / `.status` / `.conclusion`)", () => {
    // 🔑 เส้นแบ่งของแบบคือ *ยืนยันว่า run **ถูกสร้าง** ≠ รอว่า run **ทำงานเสร็จ***
    //    ⇒ สิ่งที่ทำให้ข้ามเส้นคือ **การไปแตะผลลัพธ์** ไม่ใช่ชนิดของ loop
    //    ⇒ `--json databaseId` = อ่านว่า "มีอยู่" ✅ · `--json status` = เริ่มรอผล ❌
    //      (A จับเคสหลังไม่ได้เลย ถ้า loop ยังมีเพดานอยู่)
    for (const script of runScriptsOf("dispatch")) {
      expect(script).not.toMatch(/--watch\b/);
      expect(script).not.toMatch(/--wait\b/);
      expect(script).not.toMatch(/\bgh\s+run\s+watch\b/);
      // จับที่ระดับ flag/field ไม่ใช่คำโดด — `deployment_status` ใน `env:` ต้องไม่โดนลูกหลง
      // (env ไม่ได้ถูกอ่านอยู่แล้วเพราะเราดูเฉพาะ `run:` — ข้อนี้กันคำว่า status ที่โผล่ใน `--json`)
      expect(script).not.toMatch(/--json[^\n]*\b(status|conclusion)\b/);
      expect(script).not.toMatch(/--jq[^\n]*\.(status|conclusion)\b/);
    }
  });

  it("B (กัน false-positive) — สคริปต์ปัจจุบันอ่านแค่ `databaseId` และยังมี `gh workflow run` อยู่จริง", () => {
    // ถ้า guard ข้างบนถูกเขียนแคบเกินจนไม่เคยแตะอะไรเลย มันจะผ่านตลอดกาลโดยไม่ค้ำอะไร
    // ⇒ ข้อนี้ยืนยันว่า yml ปัจจุบัน **มีของให้ตรวจจริง** และของนั้นอยู่ในรูปที่ถูกต้อง
    const scripts = runScriptsOf("dispatch").join("\n");
    expect(scripts).toMatch(/gh\s+workflow\s+run/);
    expect(scripts).toMatch(/--json\s+databaseId/);
  });

  // ── ข้อกำหนด 4-C: เพดานที่แพลตฟอร์มบังคับ ─────────────────────────────
  it("C — `dispatch` มี `timeout-minutes` และไม่เกิน 5", () => {
    // 🔑 ชั้นเดียวที่ไม่ถูกลบพร้อมไฟล์นี้ — GitHub บังคับตอนรัน ไม่ใช่ CI
    //    A/B เป็น test ที่คนแก้กฎย่อมแก้ทิ้งไปพร้อมกัน แต่ค่านี้อยู่ในไฟล์เดียวกับสิ่งที่มันคุม
    const timeout = workflow.jobs.dispatch["timeout-minutes"];
    expect(timeout).toBeTypeOf("number");
    expect(timeout).toBeLessThanOrEqual(5);
  });

  // ── ข้อกำหนด 5: ผู้ตรวจ ≠ ผู้ถูกตรวจ ──────────────────────────────────
  it("ไม่มีสเต็ปใดใช้ `actions/cache/restore` เป็นผู้ตรวจ — และ `cache/save` ยังอยู่", () => {
    const allUses = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .map((s) => s.uses)
      .filter((u): u is string => typeof u === "string");

    // ⛔ `restore` ถูกใช้เป็น **ผู้ตรวจ** ไม่ได้ — มันคือชิ้นส่วนเดียวกับผู้ถูกตรวจ (§H-12 ส่วนที่ 2)
    //    หมายเหตุ: สเต็ป `Restore readiness state` ตอนต้น job ใช้ `actions/cache/restore` โดยชอบธรรม
    //    ⇒ ข้อนี้จึงค้ำว่า **จำนวนต้องไม่เกิน 1** (คือมีได้แค่ตัวที่ทำหน้าที่ restore จริง ๆ)
    //    ถ้ามีตัวที่สองโผล่มา แปลว่ามีคนเอามันมาใช้ verify = สิ่งที่แบบห้าม
    //
    // 🔴 **เคสนี้เดี่ยว ๆ ปิดช่องไม่ได้ — ต้องอ่านคู่กับเคส "assertion ใช้ `gh api`" ด้านล่างเสมอ**
    //    ช่องที่เหลือ: ลบสเต็ป `Restore readiness state` ที่ชอบธรรมทิ้ง แล้วเอา `cache/restore`
    //    มาทำหน้าที่ verify แทน ⇒ **ยังนับได้ 1 ⇒ เคสนี้เขียว** ทั้งที่ผู้ตรวจกลายเป็นชิ้นส่วน
    //    เดียวกับผู้ถูกตรวจแล้ว — คือสิ่งที่ §H-12 ห้ามตรงตัว
    //    ⇒ ตัวที่ปิดช่องนี้คือเคสถัดไปที่บังคับว่า **ต้องมี `gh api …/actions/caches` อยู่จริง**
    //    ⛔ **ห้ามลบเคสใดเคสหนึ่งโดยคิดว่าอีกเคสครอบแล้ว** — คนละครึ่งของกฎเดียวกัน
    const restores = allUses.filter((u) => u.startsWith("actions/cache/restore"));
    expect(restores.length).toBeLessThanOrEqual(1);

    // save ต้องยังอยู่ — ไม่งั้นไม่มีอะไรให้ assertion ตรวจตั้งแต่แรก
    expect(allUses.some((u) => u.startsWith("actions/cache/save"))).toBe(true);
  });

  it("assertion ของ cache ตรวจผ่าน REST API และมี retry แบบมีเพดาน", () => {
    const scripts = runScriptsOf("check").join("\n");
    // ผู้ตรวจต้องเป็นคนละชิ้นกับผู้ถูกตรวจ ⇒ ต้องเรียก API ไม่ใช่ action
    expect(scripts).toMatch(/gh\s+api\s+"?\/repos\/[^\n]*actions\/caches/);
    // เพดาน: ห้าม loop ไม่รู้จบในสเต็ป verify เช่นกัน
    expect(scripts).not.toMatch(/\b(while|until)\b/);
  });

  // ── ข้อกำหนด 1: permission ──────────────────────────────────────────────
  it("`dispatch` ได้ `actions: write` · `check` ได้แค่ `actions: read`", () => {
    // `check` ต้องไม่มีสิทธิ์สั่ง workflow — สิทธิ์เกินความจำเป็นคือพื้นผิวที่ไม่มีใครเฝ้า
    expect(workflow.jobs.dispatch.permissions?.actions).toBe("write");
    expect(workflow.jobs.check.permissions?.actions).toBe("read");
  });
});
