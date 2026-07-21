/**
 * src/app/api/realtime/__tests__/token.test.ts
 * Unit tests สำหรับ POST /api/realtime/token + mintRealtimePresenceToken (Phase 35 Slice 1)
 *
 * P0 invariants:
 *   - claim ครบ (role/aud/tenantId/memberId/sub/exp) + tenantId === ctx.tenantId
 *   - header มี kid + typ:"JWT" + alg ตรง (ES256)
 *   - exp = iat + 60
 *   - verify ได้ด้วย public key คู่กัน (aud/iss ตรง)
 *   - reject/401 เมื่อ requireAgent throw (ไม่ใช่ agent)
 *   - ⚠️ tenantId ใน token ไม่มาจาก body แม้ client ส่ง tenantId ปลอมมา
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  generateKeyPair,
  exportPKCS8,
  jwtVerify,
  decodeProtectedHeader,
  type KeyLike,
} from "jose";
import { makeNextRequest } from "@/app/api/__tests__/_helpers";

const { requireAgentMock } = vi.hoisted(() => ({
  requireAgentMock: vi.fn(),
}));

// mock เฉพาะ requireAgent — คง toAuthErrorResponse + AuthError ตัวจริงไว้
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

const TEST_KID = "test-kid-1";
const TEST_SUPABASE_URL = "https://ref.supabase.co";
const EXPECTED_ISS = `${TEST_SUPABASE_URL}/auth/v1`;

const REAL_TENANT_ID = "tenant-real-123";
const USER_ID = "user-xyz";
const MEMBER_ID = "member-abc";

let publicKey: KeyLike;

// import route + AuthError หลัง env ถูกตั้ง (realtime.ts อ่าน env ตอน call ไม่ใช่ตอน load)
async function getRoute() {
  return import("@/app/api/realtime/token/route");
}

beforeAll(async () => {
  // generate ES256 keypair (extractable เพื่อ export PEM)
  const kp = await generateKeyPair("ES256", { extractable: true });
  publicKey = kp.publicKey;
  const privatePem = await exportPKCS8(kp.privateKey);

  process.env.SUPABASE_REALTIME_JWT_PRIVATE_KEY = privatePem;
  process.env.SUPABASE_REALTIME_JWT_KID = TEST_KID;
  process.env.SUPABASE_URL = TEST_SUPABASE_URL;
});

beforeEach(() => {
  requireAgentMock.mockReset();
});

function mockAgent(tenantId = REAL_TENANT_ID) {
  requireAgentMock.mockResolvedValue({
    user: { id: USER_ID },
    member: { id: MEMBER_ID },
    ctx: { tenantId, plan: "pro" },
  });
}

describe("POST /api/realtime/token", () => {
  it("mint token: claim ครบ + tenantId === ctx.tenantId + verify ได้ด้วย public key", async () => {
    mockAgent();
    const { POST } = await getRoute();

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(typeof body.data.token).toBe("string");
    expect(typeof body.data.expiresAt).toBe("number");

    // verify ด้วย public key คู่กัน + ตรวจ aud/iss
    const { payload } = await jwtVerify(body.data.token, publicKey, {
      audience: "authenticated",
      issuer: EXPECTED_ISS,
    });

    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
    expect(payload.sub).toBe(USER_ID);
    expect(payload.tenantId).toBe(REAL_TENANT_ID);
    expect(payload.memberId).toBe(MEMBER_ID);
    expect(payload.iss).toBe(EXPECTED_ISS);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");

    // expiresAt ที่คืน = exp ใน claim
    expect(body.data.expiresAt).toBe(payload.exp);
  });

  it("header มี kid + typ:'JWT' + alg=ES256", async () => {
    mockAgent();
    const { POST } = await getRoute();
    const res = await POST();
    const body = await res.json();

    const header = decodeProtectedHeader(body.data.token);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(TEST_KID);
    expect(header.typ).toBe("JWT");
  });

  it("exp = iat + 60 (TTL 60s)", async () => {
    mockAgent();
    const { POST } = await getRoute();
    const res = await POST();
    const body = await res.json();

    const { payload } = await jwtVerify(body.data.token, publicKey);
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it("tenantId ใน token มาจาก ctx เท่านั้น — ไม่มาจาก body ที่ client ส่ง tenantId ปลอม", async () => {
    mockAgent(REAL_TENANT_ID);
    const { POST } = await getRoute();

    // client พยายาม inject tenantId ปลอมผ่าน body (route handler ไม่อ่าน body เลย)
    makeNextRequest("https://acme.gethelpwise.xyz/api/realtime/token", {
      method: "POST",
      body: { tenantId: "evil-tenant", ticketId: "t1" },
    });

    const res = await POST();
    const body = await res.json();
    const { payload } = await jwtVerify(body.data.token, publicKey);

    expect(payload.tenantId).toBe(REAL_TENANT_ID);
    expect(payload.tenantId).not.toBe("evil-tenant");
  });

  it("reject 401 เมื่อ requireAgent throw (ไม่ใช่ agent)", async () => {
    const { AuthError } = await import("@/lib/auth");
    requireAgentMock.mockRejectedValue(
      new AuthError("Token ไม่ถูกต้องสำหรับ endpoint นี้", 401)
    );
    const { POST } = await getRoute();

    const res = await POST();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
