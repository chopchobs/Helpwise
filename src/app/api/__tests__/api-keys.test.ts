/**
 * src/app/api/__tests__/api-keys.test.ts
 * Integration tests สำหรับ /api/api-keys (GET, POST) และ /api/api-keys/:id (DELETE)
 *
 * P1 invariants:
 *   - non-OWNER/ADMIN (requireAgent role check) → 403
 *   - feature api_access ปิด → 403 FEATURE_LOCKED
 *   - POST success → คืน plaintextKey (ครั้งเดียว) + apiKey DTO
 *     - audit `after` มีแค่ {name, keyPrefix} ไม่มี plaintext/keyHash
 *     - create เก็บ keyHash+keyPrefix เท่านั้น (ไม่เก็บ plaintext)
 *   - DELETE → soft revoke (update revokedAt), ไม่เจอ → 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";
import { NextRequest } from "next/server";

const { fakeDb, requireAgentMock, hasFeatureMock, auditLogMock } = vi.hoisted(() => {
  const fakeDb = {
    apiKey: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    hasFeatureMock: vi.fn(),
    auditLogMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/features", () => ({
  hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  FEATURE_KEYS: { API_ACCESS: "api_access" },
}));

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

// mock เฉพาะ requireAgent — ใช้ toAuthErrorResponse จริงจาก @/lib/auth
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

import { GET, POST } from "@/app/api/api-keys/route";
import { DELETE } from "@/app/api/api-keys/[id]/route";
import { AuthError } from "@/lib/auth";

const SESSION = {
  user: { id: "user-1", name: "Owner" },
  member: { id: "member-1", role: "OWNER", userId: "user-1" },
  ctx: defaultCtx(),
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
  hasFeatureMock.mockResolvedValue(true);
});

describe("GET /api/api-keys", () => {
  it("non-OWNER/ADMIN → requireAgent throws 403, route คืน 403", async () => {
    requireAgentMock.mockRejectedValue(
      new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN เพื่อดำเนินการนี้", 403)
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("feature api_access ปิด → 403 FEATURE_LOCKED", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
  });

  it("success → คืนรายการ apiKeys DTO (ไม่มี keyHash)", async () => {
    fakeDb.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        name: "My Key",
        keyPrefix: "hw_live_AbCd",
        lastUsedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        revokedAt: null,
      },
    ]);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.apiKeys).toHaveLength(1);
    expect(json.data.apiKeys[0]).not.toHaveProperty("keyHash");
    expect(json.data.apiKeys[0].keyPrefix).toBe("hw_live_AbCd");
  });
});

describe("POST /api/api-keys", () => {
  function makeReq(body: unknown) {
    return makeNextRequest("https://acme.helpwise.com/api/api-keys", {
      method: "POST",
      body,
    });
  }

  it("non-OWNER/ADMIN → 403", async () => {
    requireAgentMock.mockRejectedValue(
      new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN เพื่อดำเนินการนี้", 403)
    );

    const res = await POST(makeReq({ name: "My Key" }));
    expect(res.status).toBe(403);
  });

  it("feature api_access ปิด → 403 FEATURE_LOCKED, ไม่ create", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await POST(makeReq({ name: "My Key" }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.apiKey.create).not.toHaveBeenCalled();
  });

  it("name ว่าง → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ name: "" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("success → คืน plaintextKey + DTO; create เก็บ keyHash+keyPrefix เท่านั้น; audit.after ไม่มี plaintext/keyHash", async () => {
    fakeDb.apiKey.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "key-new",
      name: data.name,
      keyHash: data.keyHash,
      keyPrefix: data.keyPrefix,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastUsedAt: null,
      revokedAt: null,
    }));

    const res = await POST(makeReq({ name: "Production Key" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(typeof json.data.plaintextKey).toBe("string");
    expect(json.data.plaintextKey.startsWith("hw_live_")).toBe(true);
    expect(json.data.apiKey).not.toHaveProperty("plaintextKey");
    expect(json.data.apiKey).not.toHaveProperty("keyHash");

    // create call data — ต้องมี keyHash + keyPrefix, ไม่มี plaintext field
    const createArg = fakeDb.apiKey.create.mock.calls[0][0];
    expect(createArg.data).toHaveProperty("keyHash");
    expect(createArg.data).toHaveProperty("keyPrefix");
    expect(createArg.data).not.toHaveProperty("plaintext");
    // keyHash ไม่ควรเท่ากับ plaintextKey ที่ return ไป
    expect(createArg.data.keyHash).not.toBe(json.data.plaintextKey);

    // audit after ต้องมีแค่ {name, keyPrefix}
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.created",
        after: { name: "Production Key", keyPrefix: createArg.data.keyPrefix },
      })
    );
    const auditArg = auditLogMock.mock.calls[0][0];
    expect(auditArg.after).not.toHaveProperty("keyHash");
    expect(auditArg.after).not.toHaveProperty("plaintext");
  });

  it("body ไม่ใช่ JSON → 400 INVALID_JSON", async () => {
    const rawReq = new NextRequest(
      new Request("https://acme.helpwise.com/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{{",
      })
    );
    const res = await POST(rawReq);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });
});

describe("DELETE /api/api-keys/:id", () => {
  function call(id: string) {
    return DELETE(new Request(`https://acme.helpwise.com/api/api-keys/${id}`), {
      params: Promise.resolve({ id }),
    });
  }

  it("non-OWNER/ADMIN → 403", async () => {
    requireAgentMock.mockRejectedValue(
      new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN เพื่อดำเนินการนี้", 403)
    );

    const res = await call("key-1");
    expect(res.status).toBe(403);
  });

  it("feature api_access ปิด → 403 FEATURE_LOCKED", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await call("key-1");
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
  });

  it("key ไม่เจอ (revoked แล้ว หรือ cross-tenant) → 404", async () => {
    fakeDb.apiKey.findFirst.mockResolvedValue(null);

    const res = await call("key-missing");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.apiKey.update).not.toHaveBeenCalled();
  });

  it("success → soft revoke ผ่าน update({ data: { revokedAt } }) + audit log", async () => {
    fakeDb.apiKey.findFirst.mockResolvedValue({ id: "key-1" });
    fakeDb.apiKey.update.mockResolvedValue({});

    const res = await call("key-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("key-1");

    const updateArg = fakeDb.apiKey.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "key-1" });
    expect(updateArg.data.revokedAt).toBeInstanceOf(Date);

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.revoked",
        targetId: "key-1",
      })
    );
  });
});
