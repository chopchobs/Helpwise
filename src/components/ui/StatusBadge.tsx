import { getStatusStyle } from "@/lib/ticket-ui";
import type { TicketStatus } from "@/types/ticket";

interface StatusBadgeProps {
  status: TicketStatus;
  className?: string;
}

// badge แสดงสถานะ ticket ตาม semantic color mapping ของ design system
export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const { label, bg, text, border } = getStatusStyle(status);

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
