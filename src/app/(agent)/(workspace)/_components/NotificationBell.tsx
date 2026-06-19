"use client";

/**
 * NotificationBell — กระดิ่งแจ้งเตือนใน topbar ของ agent workspace
 *
 * ⚠️ agent-audience เท่านั้น — วางใน (agent) เท่านั้น ห้ามใช้ฝั่ง portal
 *
 * fetch /api/notifications ตอน mount (cookie session ส่งผ่าน credentials: "include"
 * เหมือน pattern หน้า ticket list); คลิกกระดิ่ง → เปิด dropdown แสดงรายการ
 * คลิกรายการที่ยังไม่อ่าน → PATCH mark read แล้ว optimistic update + ลด unreadCount
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { formatDate } from "@/lib/ticket-ui";
import type {
  NotificationDTO,
  NotificationListResponse,
} from "@/types/notification";

// =============================================================================
// HELPERS
// =============================================================================

/** ข้อความสำหรับแต่ละ type — แยกเป็น map เผื่อ type เพิ่มในอนาคต */
function notificationLabel(type: NotificationDTO["type"]): string {
  switch (type) {
    case "TICKET_ASSIGNED":
      return "คุณได้รับมอบหมาย ticket";
    default:
      return "การแจ้งเตือน";
  }
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface NotificationItemProps {
  notification: NotificationDTO;
  onMarkRead: (id: string) => void;
  onNavigate: () => void;
}

function NotificationItem({
  notification,
  onMarkRead,
  onNavigate,
}: NotificationItemProps) {
  const isUnread = notification.readAt === null;
  const label = notificationLabel(notification.type);

  // คลิกรายการที่ยังไม่อ่าน → mark read; ถ้ามี ticketId ก็ปิด dropdown แล้วให้ลิงก์พาไป
  function handleClick() {
    if (isUnread) onMarkRead(notification.id);
    if (notification.ticketId) onNavigate();
  }

  const content = (
    <div className="flex items-start gap-2.5">
      {/* dot บอกสถานะยังไม่อ่าน */}
      <span
        className={[
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          isUnread ? "bg-primary" : "bg-transparent",
        ].join(" ")}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted">
          {formatDate(notification.createdAt)}
        </p>
      </div>
    </div>
  );

  const baseClass = [
    "block w-full px-3 py-2.5 text-left transition-colors focus:outline-none focus:bg-stone",
    isUnread ? "bg-primary-tint hover:bg-primary-tint/70" : "hover:bg-stone",
  ].join(" ");

  // มี ticketId → เป็นลิงก์ไปหน้า ticket; ไม่มี → เป็นปุ่ม mark read อย่างเดียว
  if (notification.ticketId) {
    return (
      <li role="none">
        <Link
          href={`/tickets/${notification.ticketId}`}
          role="menuitem"
          onClick={handleClick}
          className={baseClass}
        >
          {content}
        </Link>
      </li>
    );
  }

  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        onClick={handleClick}
        className={baseClass}
      >
        {content}
      </button>
    </li>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<NotificationDTO[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", {
        credentials: "include",
      });
      const json = (await res.json()) as NotificationListResponse;
      if (res.ok && json.data) {
        setNotifications(json.data.notifications);
        setUnreadCount(json.data.unreadCount);
      }
    } catch {
      // ไม่ critical — กระดิ่งแค่ไม่แสดงรายการ ถ้าโหลดไม่ได้
    }
  }, []);

  // โหลดครั้งเดียวตอน mount — defer ผ่าน microtask กัน setState synchronous ใน effect body
  useEffect(() => {
    queueMicrotask(() => void fetchNotifications());
  }, [fetchNotifications]);

  // mark read แบบ optimistic: อัปเดต UI ทันที แล้วยิง PATCH (ไม่ rollback — ไม่ critical)
  const handleMarkRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === id && n.readAt === null
          ? { ...n, readAt: new Date().toISOString() }
          : n,
      ),
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));

    void fetch(`/api/notifications/${id}`, {
      method: "PATCH",
      credentials: "include",
    });
  }, []);

  const handleClose = useCallback(() => setIsOpen(false), []);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="relative p-1.5 rounded-lg hover:bg-stone text-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={
          unreadCount > 0
            ? `การแจ้งเตือน (${unreadCount} ยังไม่อ่าน)`
            : "การแจ้งเตือน"
        }
      >
        <Bell size={18} aria-hidden="true" />
        {/* badge unread — ซ่อนถ้า 0; strong variant ให้ text ขาว contrast ผ่าน AA */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-primary-strong text-white text-[10px] font-semibold leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <>
          {/* backdrop สำหรับปิด dropdown */}
          <div
            className="fixed inset-0 z-10"
            aria-hidden="true"
            onClick={handleClose}
          />
          <div
            className="absolute right-0 mt-1 w-80 max-w-[calc(100vw-2rem)] bg-surface rounded-xl border border-border shadow-lg z-20 overflow-hidden"
            role="menu"
            aria-label="รายการแจ้งเตือน"
          >
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm font-semibold text-foreground">
                การแจ้งเตือน
              </p>
            </div>

            {notifications.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-sm text-muted">ยังไม่มีการแจ้งเตือน</p>
              </div>
            ) : (
              <ul
                role="none"
                className="max-h-96 overflow-y-auto divide-y divide-border"
              >
                {notifications.map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    onMarkRead={handleMarkRead}
                    onNavigate={handleClose}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
