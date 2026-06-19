/**
 * src/lib/queue.ts
 * Outbound job queue ผ่าน Upstash QStash (Phase 28 Slice 1)
 *
 * ใช้แทน inline outbound email — QStash retry job ให้เมื่อ provider ล่ม
 *
 * Interface เล็ก deep module:
 *   - SendEmailJob          — payload contract ระหว่าง producer (reply route) กับ worker route
 *   - publishSendEmailJob() — producer: publish job ไป QStash → ยิงไป worker route
 *   - verifyQStashSignature() — worker: verify signature ก่อนทำงาน (fail-closed บน production)
 *
 * ⚠️ Worker route รันนอก middleware (ไม่มี tenant context จาก subdomain) →
 *    tenantId มาจาก payload ที่ verify signature แล้วเท่านั้น
 */

import { Client, Receiver } from "@upstash/qstash";

// =============================================================================
// PAYLOAD CONTRACT
// =============================================================================

/**
 * Payload contract สำหรับ outbound email job
 *
 * ⚠️ tenantId ในนี้คือ source of truth ของ worker — worker ต้อง tenantPrisma(tenantId)
 *    ทุก query (worker ไม่มี middleware tenant context). payload นี้ถูกป้องกันด้วย
 *    QStash signature → ปลอมไม่ได้ถ้า verify ผ่าน
 */
export interface SendEmailJob {
  /** tenant เจ้าของ message — worker ใช้ scope ทุก query (ห้าม query นอก scope นี้) */
  tenantId: string;
  /** TicketMessage.id ที่จะส่งเป็น outbound email */
  messageId: string;
}

// =============================================================================
// CONFIG / URL RESOLUTION
// =============================================================================

/** path ของ worker route ที่ QStash จะยิง POST เข้ามา */
const SEND_EMAIL_WORKER_PATH = "/api/jobs/send-email";

/** path ของ SLA sweep job ที่ QStash schedule จะยิง POST เข้ามา (Slice 3) */
export const SLA_SWEEP_WORKER_PATH = "/api/jobs/sla-sweep";

/**
 * สร้าง target URL เต็มสำหรับ job route ที่ระบุ
 * base = QSTASH_TARGET_BASE_URL (origin ที่ public reachable จริง — QStash ยิงจากภายนอก)
 * ⚠️ sign-side (ตอน publish/schedule) กับ verify-side ต้องใช้ค่าเดียวกันเสมอ —
 *    request.url หลัง Vercel proxy + custom subdomain จะเพี้ยน → SignatureError
 */
export function getJobTargetUrl(path: string): string {
  const base = process.env.QSTASH_TARGET_BASE_URL;
  if (!base) {
    throw new Error(
      "[queue] QSTASH_TARGET_BASE_URL is not set — cannot resolve job target URL"
    );
  }
  // ตัด trailing slash กัน double-slash ใน URL
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * base URL ที่ QStash ใช้ยิงเข้า send-email worker route
 * (คงไว้ backward-compatible — producer/verify เดิมเรียกตัวนี้)
 */
export function getWorkerTargetUrl(): string {
  return getJobTargetUrl(SEND_EMAIL_WORKER_PATH);
}

// =============================================================================
// PRODUCER — publish job
// =============================================================================

/**
 * publish outbound email job ไป QStash
 *
 * dev fallback: ถ้าไม่มี QSTASH_TOKEN และไม่ใช่ production → log warn + no-op
 *   (เปิดทาง local dev ให้ reply flow ไม่พังโดยไม่ต้องตั้ง QStash)
 * production: ไม่มี token → throw (กัน job เงียบหายบน prod)
 */
export async function publishSendEmailJob(job: SendEmailJob): Promise<void> {
  const token = process.env.QSTASH_TOKEN;

  if (!token) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[queue] QSTASH_TOKEN is not set — cannot publish email job in production"
      );
    }
    // dev: ข้าม publish + warn (worker ไม่ถูกเรียก — email ไม่ถูกส่งจน enqueue จริง)
    console.warn(
      "[queue] QSTASH_TOKEN is not set — skipping publish in dev mode (email will NOT be sent)"
    );
    return;
  }

  const client = new Client({ token });
  await client.publishJSON({
    url: getWorkerTargetUrl(),
    body: job,
  });
}

// =============================================================================
// WORKER — verify signature (fail-closed บน production)
// =============================================================================

/** request shape ขั้นต่ำที่ verify ต้องการ — เลี่ยงผูกกับ NextRequest โดยตรง */
interface SignedRequest {
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * ผล verify: ถ้า valid คืน rawBody (ใช้ parse payload ต่อ) ไม่งั้น valid=false
 * คืน rawBody มาด้วยเพราะ verify ต้องอ่าน body (stream consume ครั้งเดียว) —
 * caller จะ re-read ไม่ได้ จึงส่งกลับให้ใช้ต่อ
 */
export interface QStashVerifyResult {
  valid: boolean;
  rawBody: string;
}

/**
 * verify QStash signature จาก request
 *
 * Behavior เมื่อ signing key ไม่ได้ตั้งค่า:
 *   - production: valid=false (reject 401) — fail-closed เด็ดขาด ห้ามข้าม verify บน prod
 *   - development: valid=true + console.warn (เหมือน sla-sweep dev fallback)
 *
 * เมื่อมี signing key: ใช้ Receiver.verify (current → next สำหรับ key rotation)
 * signature อ่านจาก header `upstash-signature`
 *
 * @param targetUrl URL ที่ QStash sign ตอน publish/schedule — default = send-email worker
 *                  worker อื่น (เช่น sla-sweep) ส่ง getJobTargetUrl(<path>) ของตัวเองเข้ามา
 *                  (resolve แบบ lazy เฉพาะตอนมี signing key — กัน throw ใน dev/no-key path)
 */
export async function verifyQStashSignature(
  request: SignedRequest,
  targetUrl?: string
): Promise<QStashVerifyResult> {
  // อ่าน body ครั้งเดียว — ต้องใช้ทั้ง verify และ parse payload
  const rawBody = await request.text();

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey || !nextSigningKey) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[send-email] QSTASH signing keys are not set — rejecting in production"
      );
      return { valid: false, rawBody };
    }
    // dev: allow แต่ warn
    console.warn(
      "[send-email] QSTASH signing keys are not set — allowing in dev mode (NOT SAFE for production)"
    );
    return { valid: true, rawBody };
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return { valid: false, rawBody };
  }

  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  try {
    // verify เทียบ signature กับ raw body — throw/false = invalid
    // ⚠️ ใช้ pinned target URL ไม่ใช่ request.url:
    //    QStash sign ด้วย target URL ตอน publish/schedule (= QSTASH_TARGET_BASE_URL + path) แต่
    //    request.url หลัง Vercel proxy + custom subdomain {slug}.helpwise.com จะไม่ตรง
    //    (host/scheme/query เพี้ยน) → SignatureError ทุก job. pin ให้ sign-side กับ
    //    verify-side อ่านค่าเดียวกันจาก env เสมอ
    //    resolve แบบ lazy ที่นี่ (หลังเช็ค signing key แล้ว) — caller ที่ไม่ส่ง targetUrl
    //    ใช้ send-email default; sla-sweep ส่ง getJobTargetUrl(SLA_SWEEP_WORKER_PATH) เอง
    //    (ถ้ามี key แต่ไม่มี base url = misconfig จริง → throw)
    const valid = await receiver.verify({
      signature,
      body: rawBody,
      url: targetUrl ?? getWorkerTargetUrl(),
    });
    return { valid, rawBody };
  } catch {
    // SignatureError → invalid (fail-closed)
    return { valid: false, rawBody };
  }
}
