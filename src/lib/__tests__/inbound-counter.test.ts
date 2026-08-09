/**
 * src/lib/__tests__/inbound-counter.test.ts
 *
 * Phase 39 ลำดับ 3 — test ที่ยึดกับกฎ erratum §C เป็นข้อ ๆ
 * ทุกเคสเป็น gate:
 *   · คลาส unsigned ห้ามทำให้เป็น FAIL ไม่ว่ามากแค่ไหน (คนนอกตรึงสถานะไม่ได้)
 *   · คลาส signed_invalid FAIL ได้ก็ต่อเมื่อ corroborate กับ heartbeat ที่ค้าง
 *   · counter ที่คนนอกกระตุ้นได้ต้อง bounded (ไม่ 1 write ต่อ 1 request) + saturate
 *   · จำแนกคลาสจากการอ่าน header เอง ห้ามอนุมานจาก valid===false
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: new Map<string, number>(),
  incrby: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ redis: mocks }));

import {
  recordInboundAttempt,
  readInboundCounters,
  evaluateInboundCounters,
  __resetInboundCounterForTest,
  getCounterWriteFailure,
  BUCKET_SATURATE_AT,
  FLUSH_MAX_PENDING,
  QSTASH_DAILY_QUOTA,
  UNSIGNED_RATE_DEGRADED_PER_HOUR,
  dailyBucketKey,
  hourlyBucketKey,
  type InboundCounters,
} from "@/lib/inbound-counter";

beforeEach(() => {
  vi.clearAllMocks();
  __resetInboundCounterForTest();
  mocks.store.clear();
  mocks.incrby.mockImplementation(async (k: string, n: number) => {
    const v = (mocks.store.get(k) ?? 0) + n;
    mocks.store.set(k, v);
    return v;
  });
  mocks.expire.mockResolvedValue(1);
  mocks.set.mockImplementation(async (k: string, v: string) => {
    mocks.store.set(k, Number(v));
    return "OK";
  });
  mocks.get.mockImplementation(async (k: string) => {
    const v = mocks.store.get(k);
    return v === undefined ? null : String(v);
  });
});

function counters(over: Partial<InboundCounters> = {}): InboundCounters {
  return {
    quotaUsed: 0,
    quotaLimit: QSTASH_DAILY_QUOTA,
    quotaPercent: 0,
    signedInvalidThisHour: 0,
    unsignedThisHour: 0,
    saturated: false,
    ...over,
  };
}

describe("§C — counter ที่คนนอกกระตุ้นได้ต้อง bounded (ไม่ 1 write ต่อ 1 request)", () => {
  it("unsigned 50 ครั้ง → ยังไม่เขียน Redis เลย (สะสมใน process)", async () => {
    for (let i = 0; i < 50; i++) await recordInboundAttempt("unsigned");
    expect(mocks.incrby).not.toHaveBeenCalled();
  });

  it("unsigned ครบ FLUSH_MAX_PENDING → flush ครั้งเดียวเป็นก้อน", async () => {
    for (let i = 0; i < FLUSH_MAX_PENDING; i++) await recordInboundAttempt("unsigned");

    const incrCalls = mocks.incrby.mock.calls.filter((c) =>
      String(c[0]).includes("unsigned")
    );
    expect(incrCalls).toHaveLength(1);
    expect(incrCalls[0][1]).toBe(FLUSH_MAX_PENDING); // เขียนยอดรวมทีเดียว
  });

  it("signed_invalid ก็ bounded เหมือนกัน (forge ได้ ⇒ คนนอกกระตุ้นได้)", async () => {
    for (let i = 0; i < 100; i++) await recordInboundAttempt("signed_invalid");
    expect(mocks.incrby).not.toHaveBeenCalled();
  });

  it("verified เขียนทันทีทุก attempt (คนนอกดันไม่ได้ ⇒ ความแม่นสำคัญกว่า)", async () => {
    for (let i = 0; i < 5; i++) await recordInboundAttempt("verified");
    const incrCalls = mocks.incrby.mock.calls.filter((c) =>
      String(c[0]).includes("verified")
    );
    expect(incrCalls).toHaveLength(5);
  });
});

describe("§C — saturate: จำนวน write ต่อวันมีขอบบนคงที่", () => {
  it("bucket ถึงเพดาน → หยุดเขียนเพิ่มถาวร", async () => {
    mocks.store.set(hourlyBucketKey("unsigned"), BUCKET_SATURATE_AT - 1);

    for (let i = 0; i < FLUSH_MAX_PENDING; i++) await recordInboundAttempt("unsigned");
    const callsAfterFirstFlush = mocks.incrby.mock.calls.length;

    // ยิงต่ออีกหลาย burst — ต้องไม่มี write เพิ่มอีกเลย
    for (let i = 0; i < FLUSH_MAX_PENDING * 3; i++) {
      await recordInboundAttempt("unsigned");
    }
    expect(mocks.incrby.mock.calls.length).toBe(callsAfterFirstFlush);
  });

  it("ค่าที่ saturate ถูกตรึงไว้ที่เพดาน ไม่โตต่อ", async () => {
    mocks.store.set(hourlyBucketKey("unsigned"), BUCKET_SATURATE_AT - 1);
    for (let i = 0; i < FLUSH_MAX_PENDING; i++) await recordInboundAttempt("unsigned");

    expect(mocks.store.get(hourlyBucketKey("unsigned"))).toBe(BUCKET_SATURATE_AT);
  });

  it("bucket ที่สร้างใหม่ถูกตั้ง TTL (ไม่มี key ค้างถาวร)", async () => {
    await recordInboundAttempt("verified");
    expect(mocks.expire).toHaveBeenCalledWith(
      dailyBucketKey("verified"),
      expect.any(Number)
    );
  });
});

describe("§C — คลาส unsigned ห้ามทำให้เป็น FAIL เด็ดขาด", () => {
  it("unsigned สูงลิ่ว + saturate → DEGRADED เท่านั้น", () => {
    const result = evaluateInboundCounters(
      counters({ unsignedThisHour: BUCKET_SATURATE_AT, saturated: true }),
      "stale"
    );
    expect(result.level).toBe("DEGRADED"); // ไม่ใช่ FAIL แม้ heartbeat ค้าง
  });

  it("ต่ำกว่า threshold → OK (เป็นข้อมูล ไม่ใช่คำพิพากษา)", () => {
    const result = evaluateInboundCounters(
      counters({ unsignedThisHour: UNSIGNED_RATE_DEGRADED_PER_HOUR }),
      "fresh"
    );
    expect(result.level).toBe("OK");
  });
});

describe("§C — คลาส signed_invalid: FAIL ต้องมี corroboration", () => {
  it("signed_invalid > 0 + heartbeat ค้าง → FAIL (เคส signing key ไม่ตรงของจริง)", () => {
    const r = evaluateInboundCounters(counters({ signedInvalidThisHour: 3 }), "stale");
    expect(r.level).toBe("FAIL");
    expect(r.reasons).toContain("signed_invalid_with_stale_heartbeat");
  });

  it("signed_invalid > 0 + heartbeat สด → DEGRADED (คนนอก forge ตรึง FAIL ไม่ได้)", () => {
    const r = evaluateInboundCounters(counters({ signedInvalidThisHour: 9999 }), "fresh");
    expect(r.level).toBe("DEGRADED");
    expect(r.reasons).toContain("signed_invalid_delivery_still_ok");
  });

  it("signed_invalid > 0 + heartbeat ยังไม่มี (ลำดับ 4) → DEGRADED + reason ที่บอกตรง ๆ", () => {
    const r = evaluateInboundCounters(counters({ signedInvalidThisHour: 1 }), "unknown");
    expect(r.level).toBe("DEGRADED"); // ไม่ FAIL (คนนอกตรึงได้) และไม่เงียบ
    expect(r.reasons).toContain("signed_invalid_corroboration_unavailable");
  });

  it("signed_invalid > 0 → สถานะห้ามเป็น OK + mark ว่าโควตาต่ำกว่าความจริง", () => {
    const r = evaluateInboundCounters(counters({ signedInvalidThisHour: 1 }), "fresh");
    expect(r.level).not.toBe("OK");
    expect(r.quotaUnderReported).toBe(true);
    expect(r.reasons).toContain("quota_under_reported");
  });
});

describe("§C — counter โควตา threshold 80% / 100%", () => {
  it("38.4% (ใช้งานปกติ 288 + probe 96) → OK", () => {
    const r = evaluateInboundCounters(counters({ quotaUsed: 384, quotaPercent: 38.4 }), "fresh");
    expect(r.level).toBe("OK");
  });

  it("99.9% (เหลือ 0.1%) → DEGRADED ไม่ใช่ PASS", () => {
    const r = evaluateInboundCounters(counters({ quotaUsed: 999, quotaPercent: 99.9 }), "fresh");
    expect(r.level).toBe("DEGRADED");
  });

  it("เคส sweep พังต่อเนื่อง 1,152/วัน = 115.2% → FAIL (เคสที่ v1 ตอบ OK)", () => {
    const r = evaluateInboundCounters(counters({ quotaUsed: 1152, quotaPercent: 115.2 }), "fresh");
    expect(r.level).toBe("FAIL");
    expect(r.reasons).toContain("quota_exhausted_115.2pct");
  });
});

describe("readInboundCounters — อ่านจาก bucket ที่ถูกต้อง", () => {
  it("คำนวณ % จากเพดาน 1,000/วัน", async () => {
    mocks.store.set(dailyBucketKey("verified"), 384);
    const c = await readInboundCounters();
    expect(c.quotaUsed).toBe(384);
    expect(c.quotaLimit).toBe(QSTASH_DAILY_QUOTA);
    expect(c.quotaPercent).toBe(38.4);
  });

  it("โควตานับเฉพาะ verified — unsigned ไม่ปนเข้าตัวเลขโควตา", async () => {
    mocks.store.set(hourlyBucketKey("unsigned"), 5000);
    const c = await readInboundCounters();
    expect(c.quotaUsed).toBe(0); // คนนอกดันตัวเลขโควตาไม่ได้
    expect(c.unsignedThisHour).toBe(5000);
  });
});

describe("§F — write ล้มต้องไปถึงสถานะ ไม่ใช่แค่ console.error", () => {
  it("flush ล้ม → ตั้ง flag (ไม่ throw ออกไปทำให้ worker ล้ม)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.incrby.mockRejectedValue(new Error("redis write down"));

    await expect(
      (async () => {
        for (let i = 0; i < FLUSH_MAX_PENDING; i++) {
          await recordInboundAttempt("unsigned");
        }
      })()
    ).resolves.toBeUndefined();

    expect(getCounterWriteFailure()).toContain("flush failed");
  });

  it("write ล้ม → สถานะห้ามเป็น OK + mark ว่าโควตาต่ำกว่าความจริง", () => {
    const r = evaluateInboundCounters(counters(), "fresh", "flush failed: redis down");
    expect(r.level).not.toBe("OK");
    expect(r.level).toBe("DEGRADED");
    expect(r.reasons).toContain("inbound_counter_write_failed");
    expect(r.quotaUnderReported).toBe(true);
    expect(r.reasons).toContain("quota_under_reported");
  });

  it("ไม่มี write failure + counter สะอาด → OK (flag ไม่ได้ติดค้างเอง)", () => {
    const r = evaluateInboundCounters(counters(), "fresh", null);
    expect(r.level).toBe("OK");
  });

  it("verified เขียนล้ม → ตั้ง flag เหมือนกัน", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.incrby.mockRejectedValue(new Error("redis write down"));
    await recordInboundAttempt("verified");
    expect(getCounterWriteFailure()).toContain("record failed");
  });

  it("bucket ที่มีค่าเสีย → throw (ห้ามอ่านเป็น 0 ซึ่งดูเหมือนไม่มี traffic)", async () => {
    mocks.get.mockResolvedValue("not-a-number");
    await expect(readInboundCounters()).rejects.toThrow(/corrupt counter bucket/);
  });
});
