/**
 * src/lib/branding.ts
 * Shared branding validation — single source of truth
 *
 * ⚠️ SECURITY NOTE:
 *   - logoUrl เปิดรับเฉพาะ https: เท่านั้น
 *     เหตุผล: http: เสี่ยง MitM, data:/javascript:/blob:/file: เป็น XSS/injection vector
 *     ถ้าปล่อย logoUrl ดิบเข้า <img src> โดยไม่ validate อาจโดน SSRF หรือ CSP bypass
 *   - accentColor รับเฉพาะ 6-digit hex เท่านั้น
 *     เหตุผล: ค่าที่มี semicolon, วงเล็บ, หรือ whitespace เป็น CSS injection vector
 *     ถ้าใส่ตรงใน style="--color-primary: <value>" อาจ inject style rules ได้
 *
 * ค่าที่ไม่ผ่าน validation → null (safe default) เสมอ
 * ยกเว้น write path (PATCH): ค่าที่ส่งมาแต่ invalid → 400 (ต้องแจ้งให้ user รู้)
 */

// =============================================================================
// TYPES
// =============================================================================

export interface TenantBranding {
  logoUrl: string | null;
  accentColor: string | null;
}

// =============================================================================
// VALIDATORS (pure functions — reused by parseBranding + Zod schema in API)
// =============================================================================

/**
 * validate logoUrl — รับเฉพาะ URL https:// ที่ valid และยาวไม่เกิน 2048 ตัวอักษร
 *
 * Security: ป้องกัน SSRF และ XSS injection ผ่าน <img src>
 *   - ต้องเริ่มต้นด้วย https: เท่านั้น (http:, data:, javascript:, blob:, file: ไม่ผ่าน)
 *   - ต้องเป็น absolute URL (ใช้ new URL() parse — relative URL จะ throw)
 *   - max 2048 ตัวอักษร (standard browser URL limit)
 */
export function validateLogoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // trim ก่อนเช็ค — กัน whitespace นำหน้า/ตามหลังหลุด length check แล้วถูก URL() normalize ทีหลัง
  const v = value.trim();
  if (v.length === 0 || v.length > 2048) return null;

  try {
    const parsed = new URL(v);
    // รับเฉพาะ https: เท่านั้น — protocol อื่น ๆ ทั้งหมดถูก reject
    if (parsed.protocol !== "https:") return null;
    return v;
  } catch {
    // URL parse ล้มเหลว = invalid หรือ relative URL
    return null;
  }
}

/**
 * validate accentColor — รับเฉพาะ 6-digit hex color (#RRGGBB)
 *
 * Security: ป้องกัน CSS injection ผ่าน style="--color-primary: <value>"
 *   - ต้องขึ้นต้นด้วย # ตามด้วยตัวเลข hex 6 ตัวพอดี
 *   - ไม่รับ 3-digit (#RGB), named color (red, blue), rgb(), rgba(), หรือ space/semicolon
 *   - semicolon และวงเล็บเป็น CSS injection vector จึง reject ทั้งหมดที่ไม่ใช่ hex 6 หลัก
 */
export function validateAccentColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // trim ก่อนเช็ค — สอดคล้องกับ validateLogoUrl
  const v = value.trim();
  // regex เข้มงวด: # + ตัวเลข hex 6 ตัวพอดี ไม่มีอะไรเพิ่ม
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) return null;
  return v;
}

// =============================================================================
// PARSE BRANDING FROM Tenant.settings Json
// =============================================================================

/**
 * parse + validate branding จาก Tenant.settings (Json field)
 *
 * ใช้สำหรับ read path: agent/me, GET /api/branding
 * ค่า invalid ทุกชนิด → null อย่างเงียบ (safe default — ไม่ crash, ไม่ inject)
 *
 * Structure ที่คาดหวัง:
 * {
 *   branding: { logoUrl: string, accentColor: string },
 *   businessHours: { ... }   ← ไม่แตะ — เป็นของ sla.ts
 * }
 */
export function parseBranding(settings: unknown): TenantBranding {
  // guard: settings ต้องเป็น object ไม่ใช่ null หรือ array
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  ) {
    return { logoUrl: null, accentColor: null };
  }

  const raw = settings as Record<string, unknown>;
  const branding = raw["branding"];

  // guard: branding ต้องเป็น object ไม่ใช่ null หรือ array
  if (
    typeof branding !== "object" ||
    branding === null ||
    Array.isArray(branding)
  ) {
    return { logoUrl: null, accentColor: null };
  }

  const b = branding as Record<string, unknown>;

  // ส่งผ่าน validator — ค่า invalid → null อัตโนมัติ
  return {
    logoUrl: validateLogoUrl(b["logoUrl"]),
    accentColor: validateAccentColor(b["accentColor"]),
  };
}
