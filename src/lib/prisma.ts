/**
 * src/lib/prisma.ts
 * Base PrismaClient singleton ผูกกับ @prisma/adapter-pg (node-postgres)
 *
 * Prisma 7 ถอด `url` ออกจาก datasource block แล้ว — runtime client ต้องรับ
 * driver adapter เข้า constructor แทน (ดู prisma.config.ts สำหรับ migrate adapter)
 *
 * ใช้ singleton pattern ผ่าน globalThis เพื่อกัน hot-reload สร้าง client ซ้ำ
 * (Next.js dev server reload module บ่อย ถ้าสร้าง PrismaClient ใหม่ทุกครั้ง
 *  pool connection จะล้นเกินและเกิด "too many connections" error)
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// ประกาศ type บน globalThis เพื่อ TypeScript ไม่ฟ้อง
const globalForPrisma = global as typeof globalThis & {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. กรุณาตั้งค่า DATABASE_URL ใน .env"
    );
  }

  // ใช้ pooled connection (pgbouncer :6543) สำหรับ runtime
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

// ใน production สร้าง client ใหม่ทุกครั้ง (process ไม่ reload)
// ใน development ใช้ global cache กัน hot-reload leak
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
