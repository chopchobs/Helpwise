/**
 * src/lib/__tests__/api-auth.test.ts
 * Integration tests สำหรับ requireApiKey() — auth surface ใหม่ของ public REST API
 *
 * Security invariants ที่ต้อง prove:
 *   - ไม่มี/ผิดรูป Authorization header → 401
 *   - pre-auth rate-limit เกิน → 429
 *   - key ไม่เจอ (revoked/cross-tenant) → 401 + query มี explicit tenantId + revokedAt:null
 *   - feature api_access ปิด → 403, แต่ key lookup ต้องเกิดก่อน hasFeature (กัน plan enumeration)
 *   - success → คืน {apiKey, ctx} + lastUsedAt update ถูกเรียก (fire-and-forget)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, DEFAULT_TENANT_ID } from "@/app/api/__tests__/_helpers";
import { hashApiKey } from "@/lib/api-key";

// =============================================================================
// MOCKS
// =============================================================================

const { fakeDb, fakeRedisCtl, getTenantContextMock, hasFeatureMock } = vi.hoisted(
  () => {
    const fakeDb: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {
      apiKey: {},
    };
    for (const method of [
      "findFirst",
      "findUnique",
      "findMany",
      "create",
      "update",
      "updateMany",
      "upsert",
      "delete",
      "count",
    ]) {
      fakeDb.apiKey[method] = vi.fn();
    }

    let incrCount = 1;
    let execError: Error | null = null;
    const ttlMock = vi.fn().mockResolvedValue(60);
    const multiMock = vi.fn(() => ({
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => {
        if (execError) throw execError;
        return [
          [null, incrCount],
          [null, 1],
        ];
      }),
    }));
    const redis = { multi: multiMock, ttl: ttlMock };
    const fakeRedisCtl = {
      redis,
      setIncrCount: (count: number) => {
        incrCount = count;
      },
      setExecError: (err: Error | null) => {
        execError = err;
      },
      ttlMock,
    };

    return {
      fakeDb,
      fakeRedisCtl,
      getTenantContextMock: vi.fn(),
      hasFeatureMock: vi.fn(),
    };
  }
);

vi.mock("@/lib/tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContextMock(...args),
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/features", () => ({
  hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  FEATURE_KEYS: { API_ACCESS: "api_access" },
}));

vi.mock("@/lib/redis", () => ({
  redis: fakeRedisCtl.redis,
}));

import { requireApiKey } from "@/lib/api-auth";
import { AuthError } from "@/lib/auth";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://acme.helpwise.com/api/v1/tickets", {
    headers,
  });
}

const PLAINTEXT_KEY = "hw_live_validkeyvalue1234567890";
const KEY_HASH = hashApiKey(PLAINTEXT_KEY);

beforeEach(() => {
  vi.clearAllMocks();
  getTenantContextMock.mockResolvedValue(defaultCtx());
  hasFeatureMock.mockResolvedValue(true);
  fakeRedisCtl.setIncrCount(1);
  fakeRedisCtl.setExecError(null);

  for (const model of Object.values(fakeDb)) {
    for (const fn of Object.values(model)) {
      fn.mockReset();
    }
  }
  fakeDb.apiKey.findFirst.mockResolvedValue(null);
  fakeDb.apiKey.update.mockResolvedValue({});
});

describe("requireApiKey", () => {
  describe("Authorization header validation", () => {
    it("ไม่มี Authorization header → AuthError 401", async () => {
      await expect(requireApiKey(makeRequest())).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it("Authorization header ไม่ใช่ Bearer scheme → 401", async () => {
      await expect(
        requireApiKey(makeRequest({ authorization: "Basic abc123" }))
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it("Bearer token ว่าง (แค่ 'Bearer ') → 401", async () => {
      await expect(
        requireApiKey(makeRequest({ authorization: "Bearer " }))
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it("Bearer token เป็น whitespace ล้วน → trim แล้วว่าง → 401", async () => {
      await expect(
        requireApiKey(makeRequest({ authorization: "Bearer    " }))
      ).rejects.toMatchObject({ statusCode: 401 });
    });
  });

  describe("pre-auth rate limit", () => {
    it("ยิงเกิน pre-auth rate-limit (count > limit) → AuthError 429", async () => {
      fakeRedisCtl.setIncrCount(101); // limit = 100
      await expect(
        requireApiKey(
          makeRequest({ authorization: `Bearer ${PLAINTEXT_KEY}` })
        )
      ).rejects.toMatchObject({ statusCode: 429 });

      // ไม่ควรไปถึง DB lookup เลย
      expect(fakeDb.apiKey.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("API key lookup", () => {
    it("key hash ไม่เจอใน db → 401 + query มี explicit tenantId + keyHash + revokedAt:null", async () => {
      fakeDb.apiKey.findFirst.mockResolvedValue(null);

      await expect(
        requireApiKey(
          makeRequest({ authorization: `Bearer ${PLAINTEXT_KEY}` })
        )
      ).rejects.toMatchObject({ statusCode: 401 });

      expect(fakeDb.apiKey.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: DEFAULT_TENANT_ID,
          keyHash: KEY_HASH,
          revokedAt: null,
        },
      });
    });

    it("key เจอแต่ feature api_access ปิด → 403 และ key lookup เกิดก่อน hasFeature (กัน plan enumeration)", async () => {
      const callOrder: string[] = [];
      fakeDb.apiKey.findFirst.mockImplementation(async () => {
        callOrder.push("findFirst");
        return { id: "key-1", tenantId: DEFAULT_TENANT_ID, keyHash: KEY_HASH, revokedAt: null };
      });
      hasFeatureMock.mockImplementation(async () => {
        callOrder.push("hasFeature");
        return false;
      });

      await expect(
        requireApiKey(
          makeRequest({ authorization: `Bearer ${PLAINTEXT_KEY}` })
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(callOrder).toEqual(["findFirst", "hasFeature"]);
    });

    it("success → คืน {apiKey, ctx} และ lastUsedAt update ถูกเรียก (fire-and-forget)", async () => {
      const apiKeyRow = {
        id: "key-1",
        tenantId: DEFAULT_TENANT_ID,
        keyHash: KEY_HASH,
        revokedAt: null,
      };
      fakeDb.apiKey.findFirst.mockResolvedValue(apiKeyRow);
      fakeDb.apiKey.update.mockResolvedValue({});

      const result = await requireApiKey(
        makeRequest({ authorization: `Bearer ${PLAINTEXT_KEY}` })
      );

      expect(result.apiKey).toEqual(apiKeyRow);
      expect(result.ctx).toEqual(defaultCtx());

      // fire-and-forget — รอ microtask queue ให้ catch chain ทำงาน
      await new Promise((r) => setTimeout(r, 0));
      expect(fakeDb.apiKey.update).toHaveBeenCalledWith({
        where: { id: "key-1" },
        data: { lastUsedAt: expect.any(Date) },
      });
    });

    it("lastUsedAt update ล้มเหลว → ไม่ throw (error ถูก catch)", async () => {
      const apiKeyRow = {
        id: "key-1",
        tenantId: DEFAULT_TENANT_ID,
        keyHash: KEY_HASH,
        revokedAt: null,
      };
      fakeDb.apiKey.findFirst.mockResolvedValue(apiKeyRow);
      fakeDb.apiKey.update.mockRejectedValue(new Error("db down"));

      await expect(
        requireApiKey(
          makeRequest({ authorization: `Bearer ${PLAINTEXT_KEY}` })
        )
      ).resolves.toMatchObject({ apiKey: apiKeyRow });

      // ให้ catch chain ทำงานจบ ไม่ unhandled rejection
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it("AuthError เป็น instance ของ AuthError export จาก @/lib/auth", async () => {
    try {
      await requireApiKey(makeRequest());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
    }
  });
});
