/**
 * src/lib/storage.ts
 * File attachment storage — Supabase Storage (private bucket) + signed-URL direct upload
 *
 * ⚠️ SECURITY RULES:
 *   - SUPABASE_SERVICE_ROLE_KEY ดึงจาก env เท่านั้น — server-only ห้าม expose ฝั่ง client
 *   - bucket เป็น private — download ต้องผ่าน signed URL (TTL สั้น) เสมอ
 *   - object path มี prefix `{tenantId}/{ticketId}/...` เพื่อ verify ownership ได้ที่ระดับ backend
 *   - ไม่เชื่อ fileSize/mimeType จาก client — ใช้ getObjectInfo() ดึงค่า authoritative จาก storage
 *   - sanitizeFileName กัน path traversal ใน storage key (strip `/ \ ..` + control chars)
 *
 * หมายเหตุ env:
 *   - อ่าน env แบบ lazy (ตอนเรียกใช้) ไม่ใช่ตอน import — ถ้า env ไม่ครบ จะ throw ชัดเจน
 *     ตอนเรียก ไม่ crash ทั้ง process ตอน import (เหมือน pattern ของ lib/stripe.ts)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// =============================================================================
// CONSTANTS (ส่วนหนึ่งของ contract — frontend อิงตามนี้)
// =============================================================================

/** ขนาดไฟล์สูงสุดต่อ attachment (25 MB) */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** จำนวน attachment สูงสุดต่อ 1 message */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** MIME allowlist — รับเฉพาะชนิดไฟล์ที่ปลอดภัย/จำเป็นต่องาน support */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** ความยาวสูงสุดของชื่อไฟล์หลัง sanitize */
const MAX_FILENAME_LENGTH = 200;

// =============================================================================
// SUPABASE ADMIN CLIENT SINGLETON (service role — server-only)
// =============================================================================

const globalForStorage = global as typeof globalThis & {
  supabaseAdmin?: SupabaseClient;
};

/**
 * อ่าน env ของ Supabase Storage — throw ชัดเจนถ้าไม่ครบ
 * เรียกตอน runtime เท่านั้น (lazy) ไม่ใช่ตอน import
 */
function readStorageEnv(): { url: string; serviceRoleKey: string } {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not set. กรุณาตั้งค่าใน .env"
    );
  }
  return { url, serviceRoleKey };
}

/** ชื่อ bucket — อ่านจาก env (default ticket-attachments) */
function getBucketName(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? "ticket-attachments";
}

/**
 * คืน Supabase admin client (service role) แบบ singleton
 * service role bypass RLS — ใช้ฝั่ง server เท่านั้น ห้าม expose key
 */
function getSupabaseAdmin(): SupabaseClient {
  if (globalForStorage.supabaseAdmin) {
    return globalForStorage.supabaseAdmin;
  }
  const { url, serviceRoleKey } = readStorageEnv();
  const client = createClient(url, serviceRoleKey, {
    auth: {
      // server-side admin client — ไม่ต้อง persist/refresh session
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  globalForStorage.supabaseAdmin = client;
  return client;
}

// =============================================================================
// FILE NAME SANITIZATION (กัน path traversal ใน storage key)
// =============================================================================

/**
 * sanitize ชื่อไฟล์ก่อนนำไปประกอบ storage key
 * - strip path separators (`/`, `\`) และ `..` — กัน path traversal / directory escape
 * - strip control chars (\x00-\x1f)
 * - จำกัดความยาว
 * - fallback เป็น "file" ถ้าหลัง strip แล้วว่าง
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    // ตัด path separators ทั้งหมด
    .replace(/[/\\]/g, "_")
    // ตัด ".." ที่อาจเหลือหลังตัด separator (กัน traversal)
    .replace(/\.\.+/g, "_")
    // ตัด control chars
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();

  const limited = cleaned.slice(0, MAX_FILENAME_LENGTH).trim();
  return limited.length > 0 ? limited : "file";
}

// =============================================================================
// PATH BUILDER
// =============================================================================

/**
 * สร้าง object path สำหรับ attachment
 * รูปแบบ: `{tenantId}/{ticketId}/{objectId}/{sanitizedFileName}`
 * - tenantId/ticketId เป็น prefix → ใช้ verify ownership ได้ก่อน gen download URL
 * - objectId เป็น opaque unique id ต่อไฟล์ → กันชนกันเมื่อชื่อไฟล์ซ้ำ
 *
 * @returns { path, objectId }
 */
export function buildAttachmentPath(
  tenantId: string,
  ticketId: string,
  fileName: string
): { path: string; objectId: string } {
  const objectId = randomUUID();
  const safeName = sanitizeFileName(fileName);
  const path = `${tenantId}/${ticketId}/${objectId}/${safeName}`;
  return { path, objectId };
}

// =============================================================================
// MIME ALLOWLIST CHECK
// =============================================================================

/** ตรวจว่า mime type อยู่ใน allowlist หรือไม่ */
export function isAllowedMimeType(m: string): boolean {
  return ALLOWED_MIME_TYPES.includes(m);
}

// =============================================================================
// SIGNED URLS
// =============================================================================

/**
 * สร้าง signed upload URL — client upload ตรงเข้า storage โดยไม่ผ่าน server
 * คืน { uploadUrl, token, path } ตาม contract
 */
export async function createSignedUploadUrl(
  path: string
): Promise<{ uploadUrl: string; token: string; path: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(getBucketName())
    .createSignedUploadUrl(path);

  if (error || !data) {
    throw new Error(
      `[storage] createSignedUploadUrl failed: ${error?.message ?? "no data"}`
    );
  }

  return { uploadUrl: data.signedUrl, token: data.token, path: data.path };
}

/**
 * สร้าง signed download URL (TTL สั้น) สำหรับ private object
 * default 60 วินาที — กัน URL รั่วแล้วใช้งานได้นาน
 */
export async function createSignedDownloadUrl(
  path: string,
  expiresInSec: number = 60
): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(getBucketName())
    .createSignedUrl(path, expiresInSec);

  if (error || !data) {
    throw new Error(
      `[storage] createSignedUrl failed: ${error?.message ?? "no data"}`
    );
  }

  return data.signedUrl;
}

// =============================================================================
// OBJECT INFO (authoritative size/mime — ไม่เชื่อ client)
// =============================================================================

/**
 * ดึงข้อมูลไฟล์จาก storage เพื่อ:
 *   1. ยืนยันว่าไฟล์ถูก upload จริง (ไม่ใช่ client หลอกว่ามี)
 *   2. ได้ size/mimeType ที่ authoritative (ไม่เชื่อค่าจาก client)
 *
 * คืน null ถ้าไฟล์ไม่มีจริง (object info ล้มเหลว / not found)
 */
export async function getObjectInfo(
  path: string
): Promise<{ size: number; mimeType: string } | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(getBucketName())
    .info(path);

  if (error || !data) {
    return null;
  }

  // info() คืน camelized: size, contentType
  const size = typeof data.size === "number" ? data.size : null;
  const mimeType = data.contentType ?? null;

  if (size === null || mimeType === null) {
    return null;
  }

  return { size, mimeType };
}
