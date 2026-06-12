/**
 * GET /api/health
 *
 * Healthcheck endpoint แบบ tenant-agnostic (global) — ใช้สำหรับ uptime monitor /
 * load balancer ตรวจสภาพ app ก่อน route traffic
 *
 * ตรวจ: app liveness (always ok) + DB (SELECT 1) + Redis (ping, timeout สั้น)
 * ไม่เรียก getTenantContext()/requireAgent() — endpoint นี้ไม่ผูกกับ tenant ใด ๆ
 *
 * Response: { data, error } ตาม convention ของโปรเจกต์
 *   healthy   -> 200 { data: { status: "ok", checks: { db: "ok", redis: "ok" } }, error: null }
 *   unhealthy -> 503 { data: { status: "error", checks: {...} }, error: "..." }
 *
 * ⚠️ ห้าม leak connection string / error detail ออกไปใน response — log แค่ message ฝั่ง server
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface HealthChecks {
  db: "ok" | "error";
  redis: "ok" | "error";
}

/** ตรวจ DB ด้วย query ที่เบาที่สุด */
async function checkDb(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    console.error("[health] DB check failed:", (err as Error).message);
    return false;
  }
}

/** ตรวจ Redis ด้วย ping + timeout สั้น กัน health endpoint ค้างถ้า Redis แขวน */
async function checkRedis(): Promise<boolean> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("redis ping timeout")), 2000)
    );
    await Promise.race([redis.ping(), timeout]);
    return true;
  } catch (err) {
    console.error("[health] Redis check failed:", (err as Error).message);
    return false;
  }
}

export async function GET() {
  const [dbOk, redisOk] = await Promise.all([checkDb(), checkRedis()]);

  const checks: HealthChecks = {
    db: dbOk ? "ok" : "error",
    redis: redisOk ? "ok" : "error",
  };

  if (dbOk && redisOk) {
    return NextResponse.json(
      { data: { status: "ok", checks }, error: null },
      { status: 200 }
    );
  }

  return NextResponse.json(
    { data: { status: "error", checks }, error: "dependency check failed" },
    { status: 503 }
  );
}
