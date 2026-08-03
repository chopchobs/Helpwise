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
    <div className="mb-3 rounded-lg border border-border bg-stone p-3">
      <div className="flex items-start gap-2">
        <Users size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            อยากเห็น real-time presence ไหม?
          </p>
          <p className="mt-0.5 text-xs text-secondary">
            คัดลอกลิงก์ด้านล่างไปเปิดใน{" "}
            <span className="font-medium text-foreground">incognito</span> หรืออีกเบราว์เซอร์
            เพื่อเข้าเป็น agent คนที่ 2 แล้วดู ticket ใบนี้พร้อมกัน — ถ้าเปิดในเบราว์เซอร์นี้
            session ปัจจุบันจะถูกทับ
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* แสดง URL เป็น text ที่ select ได้เสมอ — เผื่อ copy อัตโนมัติใช้ไม่ได้ */}
            <code className="min-w-0 flex-1 break-all rounded border border-border bg-surface px-2 py-1 text-[11px] select-all text-primary-ink">
              {shareUrl}
            </code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              aria-label="คัดลอกลิงก์สำหรับเปิดเป็น agent คนที่ 2"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary-strong px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-strong-hover focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <Copy size={13} aria-hidden="true" />
              คัดลอกลิงก์
            </button>
          </div>

          {/* live region — ประกาศผลการคัดลอกให้ screen reader ทั้งสำเร็จและล้มเหลว */}
          <p role="status" aria-live="polite" className="mt-1 text-xs text-secondary">
            {copyState === "copied" && "คัดลอกลิงก์แล้ว"}
            {copyState === "failed" &&
              "คัดลอกอัตโนมัติไม่ได้ กรุณาเลือกลิงก์ด้านบนแล้วคัดลอกเอง"}
          </p>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="ปิดคำแนะนำนี้"
          className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-surface hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
