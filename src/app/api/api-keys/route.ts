/**
 * GET  /api/api-keys — list API keys ของ tenant (agent: OWNER/ADMIN)
 * POST /api/api-keys — สร้าง API key ใหม่ (plaintext เห็นครั้งเดียว)
 *
 * ⚠️ Tenant Isolation: tenantId จาก requireAgent() เท่านั้น
 * Feature gate: api_access — ปิด → 403 FEATURE_LOCKED
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { generateApiKey } from "@/lib/api-key";
import type { ApiKeyDTO } from "@/types/api-key";

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const createApiKeySchema = z.object({
  name: z.string().min(1, "name ห้ามว่าง").max(80, "name ยาวเกิน 80 ตัวอักษร"),
});

// =============================================================================
// GET /api/api-keys — list
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx } = session;

    // feature gate: api_access ต้องเปิดอยู่ตาม plan ของ tenant
    const enabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.API_ACCESS, ctx.plan);
    if (!enabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "API access ไม่รวมอยู่ใน plan ปัจจุบัน กรุณาอัปเกรด plan",
          },
        },
        { status: 403 }
      );
    }

    const db = tenantPrisma(ctx.tenantId);
    const rows = await db.apiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    const apiKeys: ApiKeyDTO[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    }));

    return NextResponse.json({ data: { apiKeys }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/api-keys] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/api-keys — สร้าง key ใหม่
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;

    const enabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.API_ACCESS, ctx.plan);
    if (!enabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "API access ไม่รวมอยู่ใน plan ปัจจุบัน กรุณาอัปเกรด plan",
          },
        },
        { status: 403 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = createApiKeySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const { name } = parsed.data;

    // สร้าง key — เก็บแค่ hash + prefix, plaintext return ออกครั้งเดียว
    const { plaintext, keyHash, keyPrefix } = generateApiKey();

    const db = tenantPrisma(ctx.tenantId);
    const created = await db.apiKey.create({
      data: {
        tenantId: ctx.tenantId,
        name,
        keyHash,
        keyPrefix,
        createdByMemberId: member.id,
      },
    });

    const apiKey: ApiKeyDTO = {
      id: created.id,
      name: created.name,
      keyPrefix: created.keyPrefix,
      lastUsedAt: null,
      createdAt: created.createdAt.toISOString(),
      revokedAt: null,
    };

    // audit log — ห้าม log plaintext/hash
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "api_key",
      targetId: created.id,
      action: "api_key.created",
      after: { name: created.name, keyPrefix: created.keyPrefix },
    });

    return NextResponse.json(
      { data: { apiKey, plaintextKey: plaintext }, error: null },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/api-keys] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
