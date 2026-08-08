/**
 * src/app/api/health/readiness/__tests__/route.test.ts
 *
 * Phase 39 ลำดับ 2 — test ที่ยึดกับ **ข้อบังคับใน erratum §F** เป็นข้อ ๆ
 * ทุกเคสในไฟล์นี้เป็น gate ไม่ใช่ regression test ทั่วไป:
 *   · ไม่ auth ห้าม trigger outbound call แม้แต่ครั้งเดียว
 *   · ไม่ auth ห้ามมี tenant identifier / จำนวน tenant
 *   · min-interval ต้องกัน live probe จริง (เงื่อนไขความถูกต้องของตัวเลขโควตา)
 *   · ไม่พบ heartbeat = FAIL เสมอ
 *   · marker ต้องอยู่ในเนื้อ response เสมอ
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeNextRequest } from "@/app/api/__tests__/_helpers";

const mocks = vi.hoisted(() => ({
  probeQStashReadOnly: vi.fn(),
  redisStore: new Map<string, string>(),
  set: vi.fn(),
  get: vi.fn(),
  ping: vi.fn(),
}));

vi.mock("@/lib/queue", () => ({
  probeQStashReadOnly: mocks.probeQStashReadOnly,
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: mocks.get,
    set: mocks.set,
    ping: mocks.ping,
  },
}));

import { GET } from "../route";
import { READINESS_MARKER, READINESS_AUTH_HEADER } from "@/lib/readiness";

const URL_ = "https://gethelpwise.xyz/api/health/readiness";
const TOKEN = "test-readiness-token";

/** จำลอง Redis จริงพอที่ SET NX / EX จะมีความหมาย */
function installFakeRedis() {
  mocks.redisStore.clear();
  mocks.get.mockImplementation(async (k: string) => mocks.redisStore.get(k) ?? null);
  mocks.set.mockImplementation(async (k: string, v: string, ...args: string[]) => {
    const nx = args.includes("NX");
    if (nx && mocks.redisStore.has(k)) return null; // ชนกับ lock ที่ยังไม่หมดอายุ
    mocks.redisStore.set(k, v);
    return "OK";
  });
  mocks.ping.mockResolvedValue("PONG");
}

beforeEach(() => {
  vi.clearAllMocks();
  installFakeRedis();
  mocks.probeQStashReadOnly.mockResolvedValue({ ok: true, detail: "schedules.list ok" });
  process.env.READINESS_PROBE_TOKEN = TOKEN;
  process.env.VERCEL_DEPLOYMENT_ID = "dpl_test123";
  process.env.VERCEL_GIT_COMMIT_SHA = "abcdef0123456789";
  process.env.VERCEL_ENV = "production";
});

async function callWith(headers: Record<string, string> = {}) {
  const res = await GET(makeNextRequest(URL_, { headers }));
  return { res, json: await res.json() };
}

describe("readiness — marker (หลักฐานเดียวของกฎ INCONCLUSIVE §B(ค))", () => {
  it("shape ที่ไม่ auth มี marker", async () => {
    const { json } = await callWith();
    expect(json.data.marker).toBe(READINESS_MARKER);
  });

  it("shape ที่ auth มี marker", async () => {
    const { json } = await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    expect(json.data.marker).toBe(READINESS_MARKER);
  });

  it("401 (token ผิด) ก็ยังมี marker — แยก 'แอปเราปฏิเสธ' ออกจาก INCONCLUSIVE ได้", async () => {
    const { res, json } = await callWith({ [READINESS_AUTH_HEADER]: "wrong-token" });
    expect(res.status).toBe(401);
    expect(json.data.marker).toBe(READINESS_MARKER);
  });
});

describe("readiness — §F: ไม่ auth ห้าม trigger outbound call", () => {
  it("ไม่ส่ง token → ไม่เรียก QStash เลยแม้แต่ครั้งเดียว", async () => {
    await callWith();
    expect(mocks.probeQStashReadOnly).not.toHaveBeenCalled();
  });

  it("token ผิด → ไม่เรียก QStash (ไม่ fallback เป็น anonymous, ตอบ 401)", async () => {
    await callWith({ [READINESS_AUTH_HEADER]: "wrong-token" });
    expect(mocks.probeQStashReadOnly).not.toHaveBeenCalled();
  });

  it("ไม่มี snapshot → STALE (วัดไม่ได้) ไม่ใช่ OK", async () => {
    const { json } = await callWith();
    expect(json.data.status).toBe("STALE");
  });
});

describe("readiness — §F: shape ที่ไม่ auth ห้ามมี tenant identifier / จำนวน tenant", () => {
  it("body ไม่มีคำว่า tenant และไม่มี component detail", async () => {
    // ทำให้มี snapshot จริงก่อน (ผ่าน live probe) แล้วค่อยอ่านแบบ anonymous
    await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    const { json } = await callWith();

    const serialized = JSON.stringify(json).toLowerCase();
    expect(serialized).not.toContain("tenant");
    // detail ของ component = infra detail ของ provider — ไม่เสิร์ฟให้คนนอก
    expect(json.data.components).toBeUndefined();
    expect(json.data.reasons).toBeUndefined();
    // key ที่อนุญาตเท่านั้น
    expect(Object.keys(json.data).sort()).toEqual(
      ["ageSeconds", "checkedAt", "deploymentId", "marker", "staleAfterSeconds", "status"].sort()
    );
  });

  it("ไม่มี commitSha ในทางเดินที่ไม่ auth", async () => {
    await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    const { json } = await callWith();
    expect(JSON.stringify(json)).not.toContain("abcdef0123456789");
  });
});

describe("readiness — §F: min-interval ของ live probe ต้องมีจริง", () => {
  it("auth 2 ครั้งติดกัน → ยิง outbound แค่ครั้งเดียว (ครั้งที่ 2 เสิร์ฟค่าที่เก็บไว้)", async () => {
    await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    const second = await callWith({ [READINESS_AUTH_HEADER]: TOKEN });

    expect(mocks.probeQStashReadOnly).toHaveBeenCalledTimes(1);
    expect(second.json.data.source).toBe("stored");
    expect(second.json.data.liveProbeSkippedReason).toBe("min-interval");
  });

  it("lock ถูกตั้งด้วย NX + EX = ค่า min-interval (เพดาน outbound/วันเป็นเพดานจริง)", async () => {
    await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    const lockCall = mocks.set.mock.calls.find((c) => String(c[0]).includes("live-lock"));
    expect(lockCall).toBeDefined();
    expect(lockCall).toContain("NX");
    expect(lockCall).toContain("EX");
    expect(lockCall).toContain(300);
  });

  it("Redis พัง → ห้ามยิง live probe (min-interval หาย = เพดานโควตาหาย) และรายงาน FAIL", async () => {
    mocks.set.mockRejectedValue(new Error("redis down"));
    const { json } = await callWith({ [READINESS_AUTH_HEADER]: TOKEN });

    expect(mocks.probeQStashReadOnly).not.toHaveBeenCalled();
    expect(json.data.status).toBe("FAIL");
    expect(json.data.reasons).toContain("redis_error");
  });
});

describe("readiness — §F: ไม่พบ heartbeat = FAIL เสมอ", () => {
  it("ทุก dependency ปกติ แต่ heartbeat ยังไม่มี (ลำดับ 4) → FAIL ไม่ใช่ OK", async () => {
    const { res, json } = await callWith({ [READINESS_AUTH_HEADER]: TOKEN });

    expect(json.data.components.qstash.status).toBe("ok");
    expect(json.data.components.redis.status).toBe("ok");
    expect(json.data.components.heartbeat.status).toBe("missing");
    expect(json.data.status).toBe("FAIL");
    expect(json.data.reasons).toContain("heartbeat_missing");
    expect(res.status).toBe(503);
  });
});

describe("readiness — QStash ผ่าน client ตัวเดียวกับ publish", () => {
  it("live probe เรียก probeQStashReadOnly() ของ @/lib/queue (ไม่ประกอบ URL เอง)", async () => {
    await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    expect(mocks.probeQStashReadOnly).toHaveBeenCalledTimes(1);
  });

  it("QStash ล่ม → FAIL + reason qstash_error", async () => {
    mocks.probeQStashReadOnly.mockResolvedValue({ ok: false, detail: "unauthorized" });
    const { json } = await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    expect(json.data.status).toBe("FAIL");
    expect(json.data.reasons).toContain("qstash_error");
  });
});

describe("readiness — deployment identity", () => {
  it("shape ที่ auth คืน deploymentId/commitSha/env จาก Vercel system env", async () => {
    const { json } = await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    expect(json.data.deployment).toEqual({
      deploymentId: "dpl_test123",
      commitSha: "abcdef0123456789",
      env: "production",
      targetEnv: null,
    });
  });

  it("shape ที่ไม่ auth คืนเฉพาะ deploymentId (ลำดับ 5 ใช้ระบุ alias)", async () => {
    const { json } = await callWith();
    expect(json.data.deploymentId).toBe("dpl_test123");
  });
});

describe("readiness — auth", () => {
  it("READINESS_PROBE_TOKEN ไม่ได้ตั้ง → token ใด ๆ ที่ส่งมา = 401 (ไม่เงียบ)", async () => {
    delete process.env.READINESS_PROBE_TOKEN;
    const { res } = await callWith({ [READINESS_AUTH_HEADER]: TOKEN });
    expect(res.status).toBe(401);
  });

  it("header ว่าง → anonymous (ไม่ใช่ 401)", async () => {
    const { res } = await callWith({ [READINESS_AUTH_HEADER]: "" });
    expect(res.status).not.toBe(401);
  });
});
