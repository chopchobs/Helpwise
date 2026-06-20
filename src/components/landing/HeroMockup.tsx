import { Sparkles } from "lucide-react";

// Static markup mockup ของ agent workspace — decorative ทั้งหมด (ไม่ interactive)
// ใช้ token จริงให้ดูเหมือน product จริง ไม่พึ่งรูป external ที่อาจ broken
interface MockTicket {
  number: string;
  subject: string;
  status: "open" | "pending" | "urgent";
}

const MOCK_TICKETS: ReadonlyArray<MockTicket> = [
  { number: "#1042", subject: "Cannot reset workspace password", status: "urgent" },
  { number: "#1041", subject: "Invoice mismatch on May billing", status: "open" },
  { number: "#1039", subject: "API rate limit clarification", status: "pending" },
  { number: "#1038", subject: "Export tickets to CSV", status: "open" },
  { number: "#1035", subject: "SSO setup for new agents", status: "pending" },
];

// mapping สถานะ → semantic status token (label + tint + ink)
const STATUS_STYLE: Record<MockTicket["status"], { label: string; className: string }> = {
  open: { label: "Open", className: "bg-success-tint text-success" },
  pending: { label: "Pending", className: "bg-warning-tint text-warning-ink" },
  urgent: { label: "Urgent", className: "bg-danger-tint text-danger" },
};

export default function HeroMockup() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-xl lg:grid-cols-[1.4fr_1fr]"
    >
      {/* คอลัมน์ซ้าย: ticket list */}
      <div className="bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-foreground">Inbox</span>
          <span className="rounded-full bg-stone px-2 py-0.5 text-xs font-medium text-secondary">
            5 open
          </span>
        </div>
        <ul className="divide-y divide-border">
          {MOCK_TICKETS.map(function renderTicket(ticket) {
            const style = STATUS_STYLE[ticket.status];
            return (
              <li
                key={ticket.number}
                className="flex items-center gap-3 px-4 py-3"
              >
                <span className="font-mono text-xs text-muted">{ticket.number}</span>
                <span className="flex-1 truncate text-sm text-foreground">
                  {ticket.subject}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}
                >
                  {style.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* คอลัมน์ขวา: AI summary panel */}
      <div className="bg-background">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">AI Summary</span>
        </div>
        <div className="space-y-4 p-4">
          <p className="text-sm leading-relaxed text-secondary">
            Customer is locked out after a failed password reset and needs urgent
            access before their billing cycle closes.
          </p>
          <div className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Suggested reply
            </span>
            <div className="rounded-lg border border-border bg-surface p-3 text-sm text-secondary">
              Hi — I&apos;ve triggered a fresh reset link to your email. It expires in
              30 minutes; let me know once you&apos;re back in.
            </div>
          </div>
          <div className="flex gap-2">
            <span className="inline-flex items-center rounded-lg bg-primary-strong px-3 py-1.5 text-xs font-semibold text-white">
              Insert reply
            </span>
            <span className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-secondary">
              Regenerate
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
