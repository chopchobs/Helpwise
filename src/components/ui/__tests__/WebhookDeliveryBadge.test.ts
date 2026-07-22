/**
 * WebhookDeliveryBadge.test.ts — unit test ของ mapping สถานะ → semantic color
 *
 * ทดสอบ pure function getDeliveryStatusStyle() ในโหมด node (project ไม่มี jsdom — ไม่ render DOM)
 * ครอบ: ครบทุก status · ไม่มี hardcode hex · SUCCEEDED=success, PENDING=neutral, FAILED=warning, DEAD=danger
 */

import { describe, it, expect } from "vitest";
import { getDeliveryStatusStyle } from "@/components/ui/WebhookDeliveryBadge";
import type { WebhookDeliveryStatus } from "@/types/webhook";

const ALL_STATUSES: WebhookDeliveryStatus[] = [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "DEAD",
];

describe("getDeliveryStatusStyle", () => {
  it("คืน style ครบทุก status (label ไม่ว่าง)", () => {
    for (const status of ALL_STATUSES) {
      const style = getDeliveryStatusStyle(status);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.bg).not.toBe("");
      expect(style.text).not.toBe("");
      expect(style.border).not.toBe("");
    }
  });

  it("SUCCEEDED → semantic success", () => {
    const style = getDeliveryStatusStyle("SUCCEEDED");
    expect(style.bg).toBe("bg-success-tint");
    expect(style.text).toBe("text-success");
  });

  it("PENDING → neutral (stone/muted) ไม่ใช่สีสื่อผลลัพธ์", () => {
    const style = getDeliveryStatusStyle("PENDING");
    expect(style.bg).toBe("bg-stone");
    expect(style.text).toBe("text-muted");
  });

  it("FAILED → semantic warning + ใช้เฉด AA (warning-ink) สำหรับ text", () => {
    const style = getDeliveryStatusStyle("FAILED");
    expect(style.bg).toBe("bg-warning-tint");
    expect(style.text).toBe("text-warning-ink");
  });

  it("DEAD (DLQ) → semantic danger", () => {
    const style = getDeliveryStatusStyle("DEAD");
    expect(style.bg).toBe("bg-danger-tint");
    expect(style.text).toBe("text-danger");
  });

  it("ไม่มี hardcode hex ใน class ทุก status (ต้องใช้ theme token เท่านั้น)", () => {
    for (const status of ALL_STATUSES) {
      const { bg, text, border } = getDeliveryStatusStyle(status);
      for (const cls of [bg, text, border]) {
        expect(cls).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
      }
    }
  });

  it("แต่ละ status ได้ label ไม่ซ้ำกัน (ผู้ใช้แยกออก)", () => {
    const labels = ALL_STATUSES.map((s) => getDeliveryStatusStyle(s).label);
    expect(new Set(labels).size).toBe(ALL_STATUSES.length);
  });
});
