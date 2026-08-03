/**
 * หน้า Demo Entry — one-click demo login สำหรับ portfolio demo
 * เข้าถึงได้โดยไม่ต้อง login เพราะ (agent)/layout.tsx เป็น plain wrapper ไม่มี auth gate
 *   (auth gate อยู่ที่ (workspace)/layout.tsx ซึ่งไม่ครอบ route นี้)
 *
 * Server component: อ่าน agent session จาก cookie เพื่อตัดสินโหมด (ดู resolveDemoEntryMode)
 *   - ยังไม่มี session → auto-POST /api/auth/demo/login แล้ว redirect (พฤติกรรมเดิม)
 *   - persona ที่ขอ = persona ของ session อยู่แล้ว → redirect เงียบฝั่ง server (0 คลิก 0 flash)
 *   - จะทับ session ของคนอื่น/ของจริง → หน้ายืนยันก่อน (กัน cookie clobber)
 *
 * ⚠️ ไม่แตะ route auth ใด ๆ — อ่าน session ผ่าน requireAgent() ที่มีอยู่แล้วเท่านั้น
 * ⚠️ ส่งลง client ได้แค่ persona key + name — ห้ามส่ง credential (DEMO_PASSWORD อยู่ใน
 *   src/lib/demo.ts ซึ่งเป็น server-only และห้าม import จาก client)
 */

import { redirect } from "next/navigation";
import { requireAgent } from "@/lib/auth";
import { resolveDemoEntryMode } from "@/lib/demo-persona-ui";
import {
  DEMO_PERSONAS,
  isDemoPersonaKey,
  type DemoPersona,
  type DemoPersonaKey,
} from "@/lib/demo-personas";
import DemoLoginClient from "./DemoLoginClient";

interface DemoPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** searchParam ซ้ำกันได้ (?next=a&next=b) — ใช้ค่าแรกเสมอ ไม่เดารวมกัน */
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

interface CurrentSession {
  displayName: string;
  persona: DemoPersona | null;
}

/**
 * อ่าน session แบบไม่ throw — ไม่มี cookie / verify ไม่ผ่าน / ไม่ใช่ member = ถือว่า "ยังไม่มี session"
 * (fail-open ไปทางพฤติกรรมเดิม: auto-login ตามปกติ)
 */
async function readAgentSessionSafe(): Promise<CurrentSession | null> {
  try {
    const session = await requireAgent();
    return {
      displayName: session.user.name ?? session.user.email,
      // ใช้ persona ของ session ปัจจุบันเพื่อรู้ว่าอยู่ demo tenant ไหน (ไม่ต้อง query เพิ่ม)
      persona: DEMO_PERSONAS.find((p) => p.email === session.user.email) ?? null,
    };
  } catch {
    return null;
  }
}

export default async function DemoEntryPage({ searchParams }: DemoPageProps) {
  const params = await searchParams;

  // persona จาก client ได้แค่ "ชื่อ key" ที่ผ่าน strict enum — ค่าอื่น = primary (พฤติกรรมเดิม)
  const rawPersona = firstValue(params.persona);
  const persona: DemoPersonaKey = isDemoPersonaKey(rawPersona) ? rawPersona : "primary";

  // ส่งค่าดิบลงไป — validate ที่จุด redirect จริงใน client child (resolveDemoNext)
  const nextParam = firstValue(params.next);

  const session = await readAgentSessionSafe();

  const entry = resolveDemoEntryMode({
    requestedPersona: persona,
    sessionPersona: session?.persona?.key ?? null,
    hasSession: session !== null,
    nextParam,
  });

  // session ที่ขอมีอยู่แล้ว → ไม่ต้อง POST ไม่ต้องยืนยัน (ไม่มีอะไรถูกทับ)
  if (entry.mode === "redirect") {
    redirect(entry.destination);
  }

  // ชื่อ persona ปลายทางของ tenant เดียวกับ session ปัจจุบัน (ไม่ข้าม tenant)
  const targetName =
    session?.persona
      ? DEMO_PERSONAS.find(
          (p) => p.key === persona && p.tenantSlug === session.persona?.tenantSlug
        )?.name ?? null
      : null;

  return (
    <DemoLoginClient
      persona={persona}
      nextParam={nextParam}
      mode={entry.mode}
      currentName={session?.displayName ?? null}
      targetName={targetName}
    />
  );
}
