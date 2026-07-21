/**
 * CollisionBanner — เตือน agent ว่ามี agent อื่นกำลังดู/พิมพ์ตอบ ticket เดียวกันอยู่ (กันตอบชนกัน)
 *
 * agent-only (อยู่ในหน้า (agent) เท่านั้น — ห้ามโผล่ portal)
 * วางไว้เหนือ ReplyBox จุดที่ agent กำลังจะตอบ — collision สำคัญสุดตรงนี้
 *
 * collision = warning semantics (subtle) — เป็น collaboration hint ไม่ใช่ error → ใช้ warning-tint/ink
 *   - มีคนอื่น "ดู" อยู่ → เตือนเบา
 *   - มีคนอื่น "พิมพ์" อยู่ → ยกระดับเป็นเตือนเข้ม (ระวังตอบซ้ำ)
 *
 * ตรรกะการตัดสิน "แสดงอะไร" แยกเป็น pure function getCollisionState() เพื่อ unit-test ในโหมด node
 * (project ไม่มี jsdom — test ตรรกะ ไม่ render DOM) — แนวเดียวกับ engine ที่แยกใน useTicketPresence
 */

import { AlertTriangle, Eye } from "lucide-react";
import type {
  PresenceParticipant,
  TypingParticipant,
} from "@/hooks/useTicketPresence";

interface CollisionBannerProps {
  others: PresenceParticipant[];
  typing: TypingParticipant[];
}

/** ระดับความเข้มของการเตือน — "typing" คือมีคนกำลังพิมพ์ (เข้มกว่า) */
export type CollisionLevel = "viewing" | "typing";

export interface CollisionState {
  level: CollisionLevel;
  message: string;
}

/** รวมชื่อเป็นข้อความ: 1 คน = "A", หลายคน = "A และอีก N คน" */
function formatNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names[0]} และอีก ${names.length - 1} คน`;
}

/**
 * ตัดสินว่าจะแสดง banner หรือไม่ + ข้อความ/ระดับ (pure — testable ในโหมด node)
 *   - typing.length > 0 → เตือนเข้ม (มีคนกำลังพิมพ์ตอบ — ระวังตอบซ้ำ)
 *   - others.length > 0 → เตือนเบา (มีคนกำลังดูอยู่)
 *   - ไม่มีใครอื่น → null (ไม่แสดง)
 */
export function getCollisionState(
  others: PresenceParticipant[],
  typing: TypingParticipant[]
): CollisionState | null {
  if (typing.length > 0) {
    const names = formatNames(typing.map((t) => t.name));
    return { level: "typing", message: `${names} กำลังพิมพ์ตอบอยู่ — ระวังตอบซ้ำ` };
  }
  if (others.length > 0) {
    const names = formatNames(others.map((o) => o.name));
    return { level: "viewing", message: `${names} กำลังดู ticket นี้อยู่` };
  }
  return null;
}

export default function CollisionBanner({ others, typing }: CollisionBannerProps) {
  const state = getCollisionState(others, typing);
  // ไม่มีใครอื่น → ไม่ render
  if (!state) return null;

  const isTyping = state.level === "typing";

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        "flex items-center gap-2 rounded-lg bg-warning-tint px-3 py-2 text-xs border",
        // เตือนเข้มเมื่อมีคนพิมพ์ (border ชัดขึ้น) — ยังคง warning ไม่ใช่ danger
        isTyping ? "border-warning" : "border-warning-tint",
      ].join(" ")}
    >
      {isTyping ? (
        <AlertTriangle size={14} className="text-warning-ink shrink-0" aria-hidden="true" />
      ) : (
        <Eye size={14} className="text-warning-ink shrink-0" aria-hidden="true" />
      )}
      <span className={isTyping ? "text-warning-ink font-semibold" : "text-warning-ink"}>
        {state.message}
      </span>
    </div>
  );
}
