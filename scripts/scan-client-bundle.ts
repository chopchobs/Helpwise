/**
 * scripts/scan-client-bundle.ts
 * ตรวจ client bundle (`.next/static`) สองทิศ:
 *   1. FORBIDDEN — server-only secret ที่ต้อง "ไม่พบ"  (ทำงานทุกกรณี)
 *   2. REQUIRED  — ค่า NEXT_PUBLIC_* ที่ต้อง "พบ"      (เฉพาะ build ของ Vercel production)
 *
 * รัน: npm run scan:bundle   (ต้อง `npm run build` ก่อน)
 *
 * ทำไมต้องมี: กฎ "ไฟล์ไหน client import ได้/ไม่ได้" เป็นแค่คอมเมนต์ — ไม่มี tsc/eslint ตัวไหนบังคับ
 *   ถ้ามีคนเผลอ import จาก src/lib/demo.ts (ซึ่งมี DEMO_PASSWORD) ใน client component
 *   bundler จะ inline ค่านั้นลง .next/static โดยไม่มีอะไรร้อง — จับได้ที่ระดับ artifact เท่านั้น
 *   (การ grep source ว่า "ไม่มี import" พิสูจน์ได้แค่เจตนา ไม่ใช่ผลลัพธ์จริงของ bundler)
 *
 * ทำไมโหมด REQUIRED ต้องเป็น artifact-level เหมือนกัน: `NEXT_PUBLIC_*` ถูก inline เข้า bundle
 *   ตอน build ไม่ได้อ่านตอน runtime → การถาม server ตอน runtime ว่า "ตั้ง env หรือยัง" ตอบคำถามผิดข้อ
 *   (ตั้งค่าแล้วแต่ยังไม่ redeploy = server บอกมี แต่ bundle ที่ผู้ใช้โหลดยังไม่มี → false PASS)
 *   นี่คือบั๊กจริง: presence ตายเงียบบน prod 1 เดือนเพราะ NEXT_PUBLIC_SUPABASE_* ไม่เคยถูกตั้งบน Vercel
 *
 * escape hatch: `SCAN_BUNDLE_SKIP_REQUIRED=1` ปิด "เฉพาะ" โหมด REQUIRED ชั่วคราว (สำหรับ hotfix ด่วน)
 *   — FORBIDDEN ปิดไม่ได้เด็ดขาด (secret หลุด ไม่ใช่เรื่องที่ยอมได้เพื่อความเร็ว)
 *
 * เพิ่ม secret ใหม่: ใส่ใน FORBIDDEN ด้านล่าง — ดึงค่าจาก source of truth เสมอ (ห้าม hardcode ซ้ำ
 * เพราะจะ drift เงียบเมื่อค่าจริงเปลี่ยน)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// import แบบ relative — tsx resolve path alias `@/` ไม่ได้ (pattern เดียวกับ prisma/seed-demo.ts)
import { DEMO_PASSWORD } from "../src/lib/demo";
import { DEMO_PERSONAS } from "../src/lib/demo-personas";

const CLIENT_DIR = ".next/static";

/** จำนวนตัวอักษรของ anon key ที่ใช้เป็นลายเซ็น (ไม่เทียบค่าเต็ม, ไม่พิมพ์ออก log) */
const ANON_KEY_PREFIX_LEN = 20;

/** hint กลางของโหมด REQUIRED — จุดพลาดจริงคือ "ตั้งค่าแล้วแต่ไม่ redeploy" */
const REDEPLOY_HINT =
  "ตั้งค่าบน Vercel (Project → Settings → Environment Variables, scope=Production) " +
  "แล้วต้อง **redeploy** ด้วย — แก้ค่าเฉย ๆ ไม่มีผลกับ bundle ที่ deploy ไปแล้ว " +
  "เพราะ NEXT_PUBLIC_* ถูก inline เข้า client bundle ตอน build ไม่ได้อ่านตอน runtime";

interface ForbiddenValue {
  /** ค่าที่ต้องไม่พบใน client bundle */
  value: string;
  /** อธิบายให้คนที่ทำ CI แดงเข้าใจทันทีว่าต้องแก้ยังไง */
  hint: string;
}

const FORBIDDEN: ForbiddenValue[] = [
  {
    value: DEMO_PASSWORD,
    hint:
      "DEMO_PASSWORD (src/lib/demo.ts) is server-only. " +
      "Client components must import from src/lib/demo-personas.ts, not src/lib/demo.ts.",
  },
  // persona email — client ต้องรู้แค่ key + name (ดู .claude/specs/phase-37-*)
  ...DEMO_PERSONAS.map((p) => ({
    value: p.email,
    hint:
      `Demo persona email "${p.email}" must not reach the browser. ` +
      "Pass only persona key + name to client components; " +
      "identity is classified server-side (GET /api/auth/agent/me → demoPersona).",
  })),
];

interface RequiredValue {
  /** ชื่อ env key — ใช้ในรายงานแทนค่าจริง (ห้ามพิมพ์ค่าออก log) */
  envKey: string;
  /** ลายเซ็นที่ต้องพบใน bundle — แค่พอพิสูจน์ว่า inline แล้ว ไม่ต้องเป็นค่าเต็ม */
  needle: string;
  /** อธิบายว่าลายเซ็นคืออะไร (ไม่เปิดเผยค่า) */
  needleKind: string;
}

/** คำอธิบายว่าทำไม ROOT_DOMAIN เป็นแค่ advisory (ใช้ในรายงาน — อ้างชื่อ key ไม่ใช่ค่า) */
const ROOT_DOMAIN_ADVISORY_NOTE =
  "advisory — assertion อ่อน (ค่านี้มี fallback ฝังใน source เช่น src/lib/landing-links.ts) " +
  "จึงเจอใน bundle ได้แม้ env ไม่ถูกตั้งตอน build → ไม่นับเป็นหลักฐาน " +
  "ปิดช่องนี้ต้องใช้ build-time guard (P1b)";

/**
 * REQUIRED: อ่านค่าจาก process.env เท่านั้น (ห้าม hardcode) แล้วแปลงเป็น "ลายเซ็น" ที่ต้องเจอใน bundle
 * ค่าที่หายตั้งแต่ตอนสแกน = build นี้ก็ไม่มีค่าให้ inline อยู่แล้ว → รายงานเป็น missing เหมือนกัน
 *
 * ADVISORY: ค่าที่ needle "เจอเสมอ" เพราะมี fallback ใน source → แถวที่ fail ไม่ได้เลย = ความมั่นใจปลอม
 *   จึงแยกออกจากชุดที่ทำให้ exit non-zero แต่ยังสแกนต่อ เพราะยังจับเคส "ตั้ง env ผิดค่า" ได้
 *   (เช่นเผลอตั้งเป็น .com แต่ bundle มีแต่ .xyz จาก fallback → advisory ฟ้อง)
 */
function buildRequired(): {
  required: RequiredValue[];
  missingEnv: string[];
  advisory: RequiredValue[];
  advisoryMissingEnv: string[];
} {
  const required: RequiredValue[] = [];
  const missingEnv: string[] = [];
  const advisory: RequiredValue[] = [];
  const advisoryMissingEnv: string[] = [];

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (supabaseUrl) {
    // match ด้วย host พอ (<project>.supabase.co) — URL เต็มอาจถูก bundler ตัด/ต่อสตริง
    let host = "";
    try {
      host = new URL(supabaseUrl).host;
    } catch {
      host = "";
    }
    if (host) {
      required.push({
        envKey: "NEXT_PUBLIC_SUPABASE_URL",
        needle: host,
        needleKind: "host ของ Supabase project",
      });
    } else {
      missingEnv.push("NEXT_PUBLIC_SUPABASE_URL (ค่าไม่ใช่ URL ที่ parse ได้)");
    }
  } else {
    missingEnv.push("NEXT_PUBLIC_SUPABASE_URL");
  }

  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (anonKey && anonKey.length >= ANON_KEY_PREFIX_LEN) {
    // ใช้แค่ prefix — ยาวพอจะไม่ชนโดยบังเอิญ แต่ไม่ผูกกับค่าเต็ม (key หมุนบางส่วนได้)
    required.push({
      envKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      needle: anonKey.slice(0, ANON_KEY_PREFIX_LEN),
      needleKind: `prefix ${ANON_KEY_PREFIX_LEN} ตัวแรกของ anon key`,
    });
  } else {
    missingEnv.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN?.trim();
  if (rootDomain) {
    advisory.push({
      envKey: "NEXT_PUBLIC_ROOT_DOMAIN",
      needle: rootDomain,
      needleKind: "root domain",
    });
  } else {
    advisoryMissingEnv.push("NEXT_PUBLIC_ROOT_DOMAIN");
  }

  return { required, missingEnv, advisory, advisoryMissingEnv };
}

/** ไล่ไฟล์ทั้งหมดใต้ dir (recursive) */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  let files: string[];
  try {
    files = walk(CLIENT_DIR);
  } catch {
    console.error(
      `[scan:bundle] ไม่พบ ${CLIENT_DIR} — ต้องรัน \`npm run build\` ก่อน scan`
    );
    process.exit(1);
  }

  // โหมด REQUIRED บังคับเฉพาะ build ของ Vercel production เท่านั้น:
  // build ของ CI/preview/local ใช้ env คนละชุดกับ artifact ที่ผู้ใช้โหลดจริง
  // → assert ที่นั่นได้แค่ "CI เขียว" ซึ่งเป็น shape เดียวกับบั๊กที่ gate นี้ตั้งใจจับ
  const isVercelProduction = process.env.VERCEL_ENV === "production";
  const { required, missingEnv, advisory, advisoryMissingEnv } = isVercelProduction
    ? buildRequired()
    : {
        required: [] as RequiredValue[],
        missingEnv: [] as string[],
        advisory: [] as RequiredValue[],
        advisoryMissingEnv: [] as string[],
      };

  // escape hatch: gate ที่ไม่มีทางออกฉุกเฉิน = gate ที่คนจะถอดทิ้งทั้งอันตอนตี 2
  //   หลัง merge build เป็น fail-closed → ถ้า scan แดงด้วยเหตุใดก็ตาม hotfix ก็ออกไม่ได้
  //   ปิดได้เฉพาะโหมด REQUIRED เท่านั้น — FORBIDDEN (secret leak) ห้ามปิดเด็ดขาด ไม่มี escape hatch
  const skipRequired = process.env.SCAN_BUNDLE_SKIP_REQUIRED === "1";

  if (!isVercelProduction) {
    console.log(
      `[scan:bundle] ข้ามโหมด REQUIRED — VERCEL_ENV=${process.env.VERCEL_ENV ?? "(ไม่ได้ตั้ง)"} ` +
        "(บังคับเฉพาะตอน Vercel build production ซึ่งเป็น env ชุดที่ inline เข้า bundle จริง)"
    );
  }

  const hits: { file: string; forbidden: ForbiddenValue }[] = [];
  const foundNeedles = new Set<string>();

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const forbidden of FORBIDDEN) {
      if (content.includes(forbidden.value)) {
        hits.push({ file, forbidden });
      }
    }
    for (const req of [...required, ...advisory]) {
      if (!foundNeedles.has(req.envKey) && content.includes(req.needle)) {
        foundNeedles.add(req.envKey);
      }
    }
  }

  const notInBundle = required.filter((r) => !foundNeedles.has(r.envKey));

  if (hits.length > 0) {
    console.error(
      `\n❌ [scan:bundle] พบ server-only value ใน client bundle (${hits.length} จุด)\n`
    );
    for (const hit of hits) {
      console.error(`  ${hit.file}`);
      console.error(`    → ${hit.forbidden.hint}\n`);
    }
    console.error(
      "ค่าเหล่านี้ถูกส่งไปเบราว์เซอร์จริง — แก้ import ฝั่ง client แล้ว build ใหม่\n"
    );
    process.exit(1);
  }

  // บรรทัด advisory — แยกจากบล็อกหลักฐาน และไม่มีผลกับ exit code ไม่ว่าผลจะเป็นอย่างไร
  for (const key of advisoryMissingEnv) {
    console.log(
      `ℹ️  [scan:bundle] ${key}: ไม่ได้ตั้งไว้ตอน build นี้ — ${ROOT_DOMAIN_ADVISORY_NOTE}`
    );
  }
  for (const req of advisory) {
    const found = foundNeedles.has(req.envKey);
    console.log(
      `ℹ️  [scan:bundle] ${req.envKey}: ${found ? "พบ" : "ไม่พบ"} ${req.needleKind} ใน ${CLIENT_DIR}` +
        (found ? "" : " (อาจตั้ง env ผิดค่า — bundle มีแต่ค่า fallback)") +
        ` — ${ROOT_DOMAIN_ADVISORY_NOTE}`
    );
  }

  if (missingEnv.length > 0 || notInBundle.length > 0) {
    const log = skipRequired ? console.warn : console.error;
    log(
      "\n❌ [scan:bundle] client bundle ขาดค่า NEXT_PUBLIC_* ที่จำเป็น — " +
        "feature ฝั่ง client ที่ใช้ค่านี้จะตายเงียบบน production\n"
    );
    for (const key of missingEnv) {
      log(`  ${key}`);
      log(
        "    → ไม่ได้ตั้งไว้ตอน build นี้ (อ่านจาก process.env ไม่พบ / ค่าไม่ถูกรูปแบบ)\n"
      );
    }
    for (const req of notInBundle) {
      log(`  ${req.envKey}`);
      log(
        `    → ตั้งไว้แล้ว แต่ไม่พบ ${req.needleKind} ใน ${CLIENT_DIR} — ` +
          "แปลว่า bundle นี้ถูก build ตอนที่ยังไม่มีค่า หรือไม่มี client code อ้างถึงตัวแปรนี้\n"
      );
    }
    log(`${REDEPLOY_HINT}\n`);

    if (!skipRequired) {
      process.exit(1);
    }
    // ทิ้งร่องรอยใน build log ให้คนตรวจย้อนหลังเห็น ว่า gate ถูกปิดโดยเจตนา ไม่ใช่ผ่านจริง
    console.warn(
      "\n⚠️⚠️⚠️ [scan:bundle] GATE OVERRIDDEN — SCAN_BUNDLE_SKIP_REQUIRED=1 ⚠️⚠️⚠️\n" +
        "โหมด REQUIRED ถูกปิดโดยเจตนา: build นี้ผ่านทั้งที่ client bundle ขาดค่า NEXT_PUBLIC_* ข้างบน\n" +
        "เป็นมาตรการชั่วคราวสำหรับ hotfix เท่านั้น — ถอด SCAN_BUNDLE_SKIP_REQUIRED ออกทันทีหลัง hotfix ออก " +
        "แล้ว redeploy ให้ gate กลับมาบังคับ\n" +
        "(FORBIDDEN / secret-leak scan ปิดไม่ได้ และยังบังคับอยู่ใน build นี้)\n"
    );
  }

  console.log(
    `✅ [scan:bundle] สะอาด — ตรวจ ${files.length} ไฟล์ใน ${CLIENT_DIR} ` +
      `เทียบกับ ${FORBIDDEN.length} ค่าต้องห้าม` +
      // นับเฉพาะค่าที่เป็นหลักฐานจริง (fail ได้) — ห้ามนับ advisory รวมเข้ามา
      (isVercelProduction && !skipRequired
        ? ` และยืนยัน ${required.length} ค่า NEXT_PUBLIC_* ที่ต้องมีใน bundle`
        : "")
  );
}

main();
