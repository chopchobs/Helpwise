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
import { prisma } from "@/lib/prisma";
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
  /** slug ของ tenant ปัจจุบัน — null = lookup ไม่สำเร็จ (จำแนก persona ไม่ได้) */
  tenantSlug: string | null;
  persona: DemoPersona | null;
}

/**
 * อ่าน session แบบไม่ throw — ไม่มี cookie / verify ไม่ผ่าน / ไม่ใช่ member = ถือว่า "ยังไม่มี session"
 * (fail-open ไปทางพฤติกรรมเดิม: auto-login ตามปกติ)
 *
 * ⚠️ persona ต้อง match `email + tenantSlug` คู่กันเสมอ (เหมือน /api/auth/agent/me และ demo-login):
 *   email อย่างเดียวไม่พอ — user คนเดียวเป็น member ได้หลาย tenant ถ้าจำแนกด้วย email ล้วน
 *   persona ของ tenant อื่นจะถูกนับเป็น persona ของ tenant ปัจจุบัน (cross-tenant)
 */
async function readAgentSessionSafe(): Promise<CurrentSession | null> {
  try {
    const session = await requireAgent();

    // tenantId มาจาก context ที่ middleware verify แล้วเท่านั้น (ห้ามรับจาก client)
    // lookup ล้มเหลว → slug = null → จำแนก persona ไม่ได้ → ตกไป confirm (ปลอดภัยไว้ก่อน)
    let tenantSlug: string | null = null;
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: session.ctx.tenantId },
        select: { slug: true },
      });
      tenantSlug = tenant?.slug ?? null;
    } catch (err) {
      console.error(
        "[demo:page] tenant lookup failed:",
        err instanceof Error ? err.message : String(err)
      );
    }

    return {
      displayName: session.user.name ?? session.user.email,
      tenantSlug,
      persona: tenantSlug
        ? DEMO_PERSONAS.find(
            (p) => p.tenantSlug === tenantSlug && p.email === session.user.email
          ) ?? null
        : null,
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

  // ชื่อ persona ปลายทางของ "tenant ปัจจุบัน" เท่านั้น — ไม่ใช่ tenant ที่ session เคยผูกไว้
  const currentSlug = session?.tenantSlug ?? null;
  const targetName = currentSlug
    ? DEMO_PERSONAS.find((p) => p.key === persona && p.tenantSlug === currentSlug)
        ?.name ?? null
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
