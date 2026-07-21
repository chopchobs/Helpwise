/**
 * PresenceBar — โชว์ agent อื่นที่กำลังดู ticket เดียวกัน (real-time) + typing indicator
 *
 * agent-only (อยู่ในหน้า (agent) เท่านั้น — ห้ามโผล่ portal)
 * ถ้าไม่มีใครอื่นดูอยู่และไม่มีใครพิมพ์ → ไม่ render อะไร (คืน null)
 */

import { Eye } from "lucide-react";
import type {
  PresenceParticipant,
  TypingParticipant,
} from "@/hooks/useTicketPresence";

interface PresenceBarProps {
  others: PresenceParticipant[];
  typing: TypingParticipant[];
}

/** ตัวย่อชื่อ (สูงสุด 2 ตัว) สำหรับ avatar */
function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** ข้อความ "กำลังพิมพ์" — รวมชื่อได้สูงสุด 2 คน ที่เหลือเป็น "และอีก N คน" */
function formatTyping(typing: TypingParticipant[]): string {
  const names = typing.map((t) => t.name);
  if (names.length === 1) return `${names[0]} กำลังพิมพ์…`;
  if (names.length === 2) return `${names[0]} และ ${names[1]} กำลังพิมพ์…`;
  return `${names[0]} และอีก ${names.length - 1} คน กำลังพิมพ์…`;
}

const MAX_VISIBLE_AVATARS = 3;

export default function PresenceBar({ others, typing }: PresenceBarProps) {
  // ไม่มีใครอื่นดูอยู่ + ไม่มีใครพิมพ์ → ไม่ render
  if (others.length === 0 && typing.length === 0) return null;

  const visible = others.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = others.length - visible.length;
  const typingText = typing.length > 0 ? formatTyping(typing) : null;

  return (
    <div className="flex items-center gap-2 text-xs text-secondary" aria-live="polite">
      {others.length > 0 && (
        <div className="flex items-center gap-1.5">
          <Eye size={13} className="text-muted" aria-hidden="true" />
          <div className="flex -space-x-1.5">
            {visible.map((agent) => (
              <span
                key={agent.memberId}
                title={`${agent.name} กำลังดู ticket นี้`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-surface bg-stone text-[10px] font-semibold text-secondary"
              >
                {getInitials(agent.name)}
              </span>
            ))}
            {overflow > 0 && (
              <span
                title={`และอีก ${overflow} คน`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-surface bg-stone text-[10px] font-semibold text-muted"
              >
                +{overflow}
              </span>
            )}
          </div>
          <span className="text-muted">กำลังดูอยู่</span>
        </div>
      )}

      {typingText && (
        <span className="text-primary-ink italic">{typingText}</span>
      )}
    </div>
  );
}
