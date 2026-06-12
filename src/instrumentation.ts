/**
 * src/instrumentation.ts
 * Next.js instrumentation hook — register() รันครั้งเดียวตอน server start
 * (ไม่รันตอน build, ไม่ bundle ไปฝั่ง client)
 *
 * ใช้ตรวจ required env vars แบบ fail-fast: ถ้าขาดตัวที่จำเป็นจริง ๆ
 * ให้ throw ทันทีตอน startup (ดีกว่าไป throw ตอน request แรกเข้ามา)
 *
 * ⚠️ guard ด้วย NEXT_RUNTIME === "nodejs" — ไม่รันบน Edge runtime
 * ⚠️ ข้าม validation ตอน NODE_ENV === "test" — vitest ตั้ง dummy env ไม่ครบตามจริง
 */

/** required env — ขาดแล้ว fatal (throw) */
const REQUIRED_ENV_VARS = [
  "AUTH_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
  "NEXT_PUBLIC_ROOT_DOMAIN",
  "STRIPE_SECRET_KEY",
] as const;

/** optional env — ขาดแล้วแค่ warn (มี dev fallback / ใช้เฉพาะบาง feature) */
const RECOMMENDED_ENV_VARS = [
  "STRIPE_WEBHOOK_SECRET",
  "EMAIL_PROVIDER",
  "EMAIL_PROVIDER_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_INBOUND_WEBHOOK_SECRET",
  "SLA_SWEEP_SECRET",
] as const;

const MIN_AUTH_SECRET_LENGTH = 32;

/** ตรวจ required env ครบหรือไม่ + AUTH_SECRET ความยาวพอหรือไม่ — throw ถ้าไม่ผ่าน */
function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  const authSecret = process.env.AUTH_SECRET;
  if (authSecret && authSecret.length < MIN_AUTH_SECRET_LENGTH) {
    missing.push(
      `AUTH_SECRET (ต้องมีความยาวอย่างน้อย ${MIN_AUTH_SECRET_LENGTH} ตัวอักษร)` as never
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `[instrumentation] Missing/invalid required environment variables: ${missing.join(
        ", "
      )}`
    );
  }

  const missingRecommended = RECOMMENDED_ENV_VARS.filter(
    (key) => !process.env[key]
  );
  if (missingRecommended.length > 0) {
    console.warn(
      `[instrumentation] Missing recommended environment variables (some features may be disabled): ${missingRecommended.join(
        ", "
      )}`
    );
  }
}

export async function register(): Promise<void> {
  // รันเฉพาะ Node.js runtime — ข้าม Edge
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // vitest ตั้ง dummy env ไม่ครบตามจริง — ข้าม validation ตอน test
  if (process.env.NODE_ENV === "test") {
    return;
  }

  validateEnv();
}
