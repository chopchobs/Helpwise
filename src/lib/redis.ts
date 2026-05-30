/**
 * src/lib/redis.ts
 * Redis client singleton สำหรับ tenant lookup cache + feature flag cache
 *
 * ใช้ ioredis (full Node.js Redis client) ผ่าน REDIS_URL (Upstash Redis)
 * Upstash รองรับ ioredis ผ่าน TLS URL: rediss://:password@host:port
 *
 * ⚠️ ioredis ใช้บน Edge runtime ไม่ได้ — ต้องใช้ใน Node.js runtime เท่านั้น
 *    (middleware ใช้ proxy.ts ที่รัน Node.js runtime จึงใช้ client นี้ได้)
 *
 * Singleton pattern: กัน hot-reload สร้าง connection ซ้ำใน dev mode
 */

import Redis from "ioredis";

const globalForRedis = global as typeof globalThis & {
  redis?: Redis;
};

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set. กรุณาตั้งค่า REDIS_URL ใน .env");
  }

  const client = new Redis(url, {
    // Upstash ต้องการ TLS (rediss://) — ioredis จัดการอัตโนมัติจาก URL
    // maxRetriesPerRequest: null สำหรับ BullMQ (Phase ถัดไป), ปกติใช้ default
    enableReadyCheck: false, // Upstash serverless ไม่รองรับ PING ตอน connect
    lazyConnect: true, // connect เมื่อใช้งานจริง ไม่ใช่ตอน import
  });

  // log error โดยไม่ crash application (Redis ล่มไม่ควร kill server)
  client.on("error", (err) => {
    // ไม่ log sensitive data — แค่ type ของ error
    console.error("[Redis] connection error:", err.message);
  });

  return client;
}

export const redis: Redis =
  globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

// =============================================================================
// CACHE KEY HELPERS
// =============================================================================

/** Cache key สำหรับ tenant lookup ตาม slug */
export function tenantSlugCacheKey(slug: string): string {
  return `tenant:slug:${slug}`;
}

/** TTL (วินาที) สำหรับ tenant cache — 5 นาที */
export const TENANT_CACHE_TTL_SECONDS = 300;
