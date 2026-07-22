/**
 * WebhookDeliveryBadge — badge สถานะการส่ง webhook (Phase 36)
 * mapping สี = semantic token ตาม design system (ห้าม hardcode hex)
 *   SUCCEEDED = success · PENDING = neutral/muted · FAILED = warning · DEAD = danger
 *
 * getDeliveryStatusStyle() แยกเป็น pure function เพื่อ unit test ได้ในโหมด node
 * (project นี้ไม่มี jsdom — ไม่ render DOM ใน test)
 */

import type { WebhookDeliveryStatus } from "@/types/webhook";

export interface DeliveryStatusStyle {
  label: string;
  /** Tailwind class สำหรับ background */
  bg: string;
  /** Tailwind class สำหรับ text */
  text: string;
  /** Tailwind class สำหรับ border */
  border: string;
}

/** map WebhookDeliveryStatus → label ไทย + semantic color */
export function getDeliveryStatusStyle(
  status: WebhookDeliveryStatus
): DeliveryStatusStyle {
  const map: Record<WebhookDeliveryStatus, DeliveryStatusStyle> = {
    // PENDING — neutral (Stone/muted) ยัง queue อยู่ ยังไม่ตัดสินผล
    PENDING: {
      label:  "รอส่ง",
      bg:     "bg-stone",
      text:   "text-muted",
      border: "border-border",
    },
    // SUCCEEDED — success (Sage green) receiver ตอบ 2xx
    SUCCEEDED: {
      label:  "สำเร็จ",
      bg:     "bg-success-tint",
      text:   "text-success",
      border: "border-success-tint",
    },
    // FAILED — warning (Amber) ล้มแต่ยัง retry ได้
    FAILED: {
      label:  "ล้มเหลว",
      bg:     "bg-warning-tint",
      text:   "text-warning-ink",
      border: "border-warning-tint",
    },
    // DEAD — danger (Sienna) ครบ retry แล้วยังล้ม = อยู่ใน DLQ
    DEAD: {
      label:  "หมดสิทธิ์ retry",
      bg:     "bg-danger-tint",
      text:   "text-danger",
      border: "border-danger-tint",
    },
  };
  return map[status];
}

interface WebhookDeliveryBadgeProps {
  status: WebhookDeliveryStatus;
  className?: string;
}

export default function WebhookDeliveryBadge({
  status,
  className,
}: WebhookDeliveryBadgeProps) {
  const { label, bg, text, border } = getDeliveryStatusStyle(status);

  return (
    <span
      className={[
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
        bg,
        text,
        border,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label}
    </span>
  );
}
