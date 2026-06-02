import { getPriorityStyle } from "@/lib/ticket-ui";
import type { TicketPriority } from "@/types/ticket";

interface PriorityBadgeProps {
  priority: TicketPriority;
  className?: string;
}

// badge แสดง priority ของ ticket ตาม semantic color mapping ของ design system
export default function PriorityBadge({ priority, className }: PriorityBadgeProps) {
  const { label, bg, text, border } = getPriorityStyle(priority);

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
