/**
 * scripts/scan-client-bundle.ts
 * ตรวจว่าไม่มี server-only secret หลุดเข้า client bundle (`.next/static`)
 *
 * รัน: npm run scan:bundle   (ต้อง `npm run build` ก่อน)
 *
 * ทำไมต้องมี: กฎ "ไฟล์ไหน client import ได้/ไม่ได้" เป็นแค่คอมเมนต์ — ไม่มี tsc/eslint ตัวไหนบังคับ
 *   ถ้ามีคนเผลอ import จาก src/lib/demo.ts (ซึ่งมี DEMO_PASSWORD) ใน client component
 *   bundler จะ inline ค่านั้นลง .next/static โดยไม่มีอะไรร้อง — จับได้ที่ระดับ artifact เท่านั้น
 *   (การ grep source ว่า "ไม่มี import" พิสูจน์ได้แค่เจตนา ไม่ใช่ผลลัพธ์จริงของ bundler)
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

  const hits: { file: string; forbidden: ForbiddenValue }[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const forbidden of FORBIDDEN) {
      if (content.includes(forbidden.value)) {
        hits.push({ file, forbidden });
      }
    }
  }

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

  console.log(
    `✅ [scan:bundle] สะอาด — ตรวจ ${files.length} ไฟล์ใน ${CLIENT_DIR} ` +
      `เทียบกับ ${FORBIDDEN.length} ค่าต้องห้าม`
  );
}

main();
