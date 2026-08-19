"use client";

/**
 * DemoPersonaBanner — ชวน visitor ของ demo เปิด "agent คนที่ 2" เพื่อเห็น real-time presence จริง
 *
 * agent-only (mount ในหน้า (agent)/tickets/[id] ข้าง PresenceBar เท่านั้น — ห้ามโผล่ portal)
 * แสดงเฉพาะ demo tenant + session เป็น persona "primary" + ยังไม่เคยปิด (ดู shouldShowDemoPersonaBanner)
 *
 * ⚠️ ไม่ทำเป็นลิงก์กดได้ธรรมดา — กดในเบราว์เซอร์เดิม = cookie ทับ session ตัวเอง แล้วจะไม่เห็น
 *   presence เลย จึงให้ "copy ลิงก์" + บอกให้เปิดใน incognito/อีกเบราว์เซอร์แทน
 */

import { useState } from "react";
import { Copy, Users, X } from "lucide-react";
import {
  buildDemoPersonaUrl,
  demoBannerDismissKey,
  shouldShowDemoPersonaBanner,
} from "@/lib/demo-persona-ui";
import type { DemoPersonaKey } from "@/lib/demo-personas";

interface DemoPersonaBannerProps {
  ticketId: string;
  /** persona ของ session ปัจจุบัน (จำแนกฝั่ง server ผ่าน /api/auth/agent/me) */
  demoPersona: DemoPersonaKey | null;
  tenantSlug: string;
}

type CopyState = "idle" | "copied" | "failed";

/** อ่านสถานะ dismiss — localStorage throw ได้ (private mode/quota) → ถือว่า "ยังไม่ปิด" */
function readDismissed(tenantSlug: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(demoBannerDismissKey(tenantSlug)) === "1";
  } catch {
    return false;
  }
}

/** จำว่าปิดแล้ว — เขียนไม่ได้ก็ไม่เป็นไร (แค่กลับมาเห็นใหม่รอบหน้า) ห้ามพังทั้งหน้า */
function writeDismissed(tenantSlug: string): void {
  try {
    window.localStorage.setItem(demoBannerDismissKey(tenantSlug), "1");
  } catch {
    // ignore
  }
}

export default function DemoPersonaBanner({
  ticketId,
  demoPersona,
  tenantSlug,
}: DemoPersonaBannerProps) {
  // อ่านครั้งเดียวตอน mount (lazy initializer) — ไม่ใช้ effect เพื่อเลี่ยง set-state-in-effect
  const [isDismissed, setIsDismissed] = useState<boolean>(() =>
    readDismissed(tenantSlug)
  );
  const [copyState, setCopyState] = useState<CopyState>("idle");

  // origin ต้องมาจากเบราว์เซอร์เท่านั้น (ห้ามประกอบจาก input/env) — ว่างระหว่าง SSR
  const [origin] = useState<string>(() =>
    typeof window === "undefined" ? "" : window.location.origin
  );

  if (!origin) return null;
  if (
    !shouldShowDemoPersonaBanner({ demoPersona, tenantSlug, isDismissed })
  ) {
    return null;
  }

  const shareUrl = buildDemoPersonaUrl(origin, ticketId);

  async function handleCopy(): Promise<void> {
    // navigator.clipboard อาจ undefined (non-secure context) หรือ reject (user ปฏิเสธ)
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    try {
      await clipboard.writeText(shareUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function handleDismiss(): void {
    writeDismissed(tenantSlug);
    setIsDismissed(true);
  }

  return (
    /*
     * แถวเดียวเสมอ (ไม่ collapse) — นี่คือ live demo: ถ้าซ่อนไว้หลังปุ่มขยาย
     * คนดูจะไม่กด แล้วไม่มีใครรู้ว่ามีฟีเจอร์ presence
     * กล่องแสดง URL ยาวถูกตัดออก เหลือแค่ปุ่มคัดลอก — จะโผล่กลับมาเฉพาะตอน copy ไม่สำเร็จ
     */
    <div className="mb-3 rounded-lg border border-border bg-stone px-3 py-2">
      <div className="flex items-center gap-2">
        <Users size={16} className="shrink-0 text-primary" aria-hidden="true" />

        {/* ข้อความบรรทัดเดียว — ตัดด้วย truncate ไม่ให้ดันความสูงบนจอแคบ */}
        <p className="min-w-0 flex-1 truncate text-xs text-secondary">
          <span className="font-semibold text-foreground">อยากเห็น real-time presence?</span>{" "}
          คัดลอกลิงก์ไปเปิดใน incognito เพื่อเข้าเป็น agent คนที่ 2
        </p>

        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label="คัดลอกลิงก์สำหรับเปิดเป็น agent คนที่ 2"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary-strong px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-primary-strong-hover focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <Copy size={13} aria-hidden="true" />
          <span className="hidden sm:inline">คัดลอกลิงก์</span>
        </button>

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="ปิดคำแนะนำนี้"
          className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-surface hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {/* live region — ประกาศผลการคัดลอกให้ screen reader ทั้งสำเร็จและล้มเหลว */}
      <p role="status" aria-live="polite" className="sr-only">
        {copyState === "copied" && "คัดลอกลิงก์แล้ว"}
        {copyState === "failed" && "คัดลอกอัตโนมัติไม่ได้ กรุณาคัดลอกลิงก์ด้านล่างเอง"}
      </p>

      {/* ยืนยันผลแบบเห็นด้วยตา — ไม่ดันความสูงเพราะแทนที่ในบรรทัดเดียวกันไม่ได้ จึงโชว์เฉพาะตอนสำเร็จ */}
      {copyState === "copied" && (
        <p className="mt-1 text-xs text-success">คัดลอกลิงก์แล้ว</p>
      )}

      {/* fallback: copy อัตโนมัติไม่ได้ (non-secure context / user ปฏิเสธ) → คืนกล่อง URL ให้เลือกเอง */}
      {copyState === "failed" && (
        <div className="mt-2">
          <p className="mb-1 text-xs text-secondary">
            คัดลอกอัตโนมัติไม่ได้ — เลือกลิงก์นี้แล้วคัดลอกเอง
          </p>
          <code className="block break-all rounded border border-border bg-surface px-2 py-1 text-[11px] select-all text-primary-ink">
            {shareUrl}
          </code>
        </div>
      )}
    </div>
  );
}
