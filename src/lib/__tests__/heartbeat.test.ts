/**
 * src/lib/__tests__/heartbeat.test.ts
 *
 * Phase 39 ลำดับ 4 — heartbeat ระดับ mechanism
 * เคสที่เป็น gate:
 *   · ไม่พบ heartbeat = missing เสมอ ห้าม fallback เป็น ok (§F)
 *   · กลไก event-driven ตัดสิน stale ไม่ได้ ⇒ ห้ามถูกนับเป็นค้าง
 *   · write ล้มต้องไปโผล่ที่ flag ไม่ใช่แค่ log (§F)
 *   · read ล้ม **ต้อง throw** ขึ้นไป ห้ามกลืนเป็น ok
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { mechanismHeartbeat: { findMany: mocks.findMany, upsert: mocks.upsert } },
}));

import {
  readHeartbeats,
  recordHeartbeat,
  getHeartbeatWriteFailure,
  __resetHeartbeatForTest,
  MECHANISMS,
  STALE_TOLERANCE_FACTOR,
} from "@/lib/heartbeat";

const NOW = new Date("2026-08-08T12:00:00.000Z");

/** สร้างแถว heartbeat ที่เต้นล่าสุดเมื่อ `agoSeconds` วินาทีที่แล้ว */
function row(mechanism: string, agoSeconds: number, expected: number | null) {
  return {
    mechanism,
    lastBeatAt: new Date(NOW.getTime() - agoSeconds * 1000),
    expectedIntervalSeconds: expected,
    updatedAt: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetHeartbeatForTest();
  mocks.upsert.mockResolvedValue({});
});

describe("§F — ไม่พบ heartbeat = missing เสมอ (ห้าม fallback เป็น ok)", () => {
  it("ตารางว่างเปล่า → missing", async () => {
    mocks.findMany.mockResolvedValue([]);
    const r = await readHeartbeats(NOW);
    expect(r.status).toBe("missing");
  });

  it("มีแต่กลไก event-driven → ยัง missing (ไม่มีตัวที่ตัดสิน stale ได้เลย)", async () => {
    mocks.findMany.mockResolvedValue([row("send-email", 10, null)]);
    const r = await readHeartbeats(NOW);
    expect(r.status).toBe("missing");
  });

  it("มี readiness-probe แต่ sla-sweep ยังไม่เคยเต้น → missing (ไม่ปล่อยผ่านเงียบ)", async () => {
    // 🔴 P2 เต้นเองทุกรอบ — ถ้าปล่อยให้ heartbeat ตัวเองทำให้สถานะเป็น ok
    //    กลไกจริงที่ตายอยู่จะถูกกลบ
    mocks.findMany.mockResolvedValue([row("readiness-probe", 5, 300)]);
    const r = await readHeartbeats(NOW);
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("sla-sweep");
  });
});

describe("heartbeat — ตัดสิน stale จากคาบที่คาด", () => {
  it("เต้นภายในหน้าต่าง → ok", async () => {
    mocks.findMany.mockResolvedValue([
      row("sla-sweep", 100, 300),
      row("readiness-probe", 30, 300),
    ]);
    const r = await readHeartbeats(NOW);
    expect(r.status).toBe("ok");
  });

  it("ค้างเกินคาบ × tolerance → error (ด้านที่สองของ corroboration §C)", async () => {
    const beyond = 300 * STALE_TOLERANCE_FACTOR + 1;
    mocks.findMany.mockResolvedValue([
      row("sla-sweep", beyond, 300),
      row("readiness-probe", 30, 300),
    ]);
    const r = await readHeartbeats(NOW);
    expect(r.status).toBe("error");
    expect(r.detail).toContain("sla-sweep");
  });

  it("อยู่พอดีที่ขอบ tolerance → ยัง ok (ไม่ noisy จาก jitter)", async () => {
    mocks.findMany.mockResolvedValue([
      row("sla-sweep", 300 * STALE_TOLERANCE_FACTOR, 300),
      row("readiness-probe", 30, 300),
    ]);
    expect((await readHeartbeats(NOW)).status).toBe("ok");
  });

  it("กลไก event-driven ที่เงียบมานาน ไม่ถูกนับเป็นค้าง", async () => {
    mocks.findMany.mockResolvedValue([
      row("sla-sweep", 100, 300),
      row("readiness-probe", 30, 300),
      row("send-email", 86_400, null), // เงียบ 1 วัน — ปกติถ้าไม่มีเมลออก
    ]);
    const r = await readHeartbeats(NOW);
    expect(r.status).toBe("ok");
    expect(r.mechanisms.find((m) => m.mechanism === "send-email")?.stale).toBeNull();
  });
});

describe("§F — read ล้มต้อง throw ขึ้นไป ห้ามกลืนเป็น ok", () => {
  it("query พัง → throw (readiness แปลงเป็น component error = FAIL)", async () => {
    mocks.findMany.mockRejectedValue(new Error("db down"));
    await expect(readHeartbeats(NOW)).rejects.toThrow("db down");
  });
});

describe("§F — write ล้มต้องไปโผล่ที่ flag", () => {
  it("upsert พัง → ไม่ throw (worker ไม่ล้ม) แต่ตั้ง flag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upsert.mockRejectedValue(new Error("db write down"));

    await expect(recordHeartbeat("sla-sweep")).resolves.toBeUndefined();
    expect(getHeartbeatWriteFailure()).toContain("sla-sweep");
  });

  it("เขียนสำเร็จหลังจากเคยล้ม → flag เคลียร์", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upsert.mockRejectedValueOnce(new Error("blip"));
    await recordHeartbeat("sla-sweep");
    expect(getHeartbeatWriteFailure()).not.toBeNull();

    await recordHeartbeat("sla-sweep");
    expect(getHeartbeatWriteFailure()).toBeNull();
  });

  it("บันทึกคาบที่คาดตอนสร้างแถวใหม่ ตรงกับตาราง MECHANISMS", async () => {
    await recordHeartbeat("sla-sweep");
    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.create.expectedIntervalSeconds).toBe(MECHANISMS["sla-sweep"]);
    // update ไม่แตะคาบ — คาบเป็นค่าคงที่ของกลไก ไม่ใช่ค่าที่ worker ตั้งใหม่ทุกครั้ง
    expect(arg.update).toEqual({ lastBeatAt: expect.any(Date) });
  });
});
