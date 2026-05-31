// Prisma 7 configuration file
// แยก connection 2 เส้นตาม Supabase:
//   - runtime PrismaClient: ใช้ driver adapter @prisma/adapter-pg + DATABASE_URL
//     (pooled, pgbouncer :6543) — ดู src/lib/prisma.ts
//   - migrate CLI: ใช้ datasource.url + DIRECT_URL (direct :5432, ไม่ผ่าน pooler)
//     เพราะ migration ต้องการ direct connection
// ทุกค่าดึงจาก .env — ห้าม hardcode connection string
// Prisma 7 + prisma.config.ts ไม่ auto-load .env → ต้อง import dotenv เอง
// (มิฉะนั้น process.env.DIRECT_URL จะ undefined ตอน config ถูก evaluate)
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  // migrate / introspect ใช้ direct connection; fallback เป็น DATABASE_URL
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
  migrations: {
    // รัน seed ผ่าน tsx เพื่อ execute TypeScript โดยตรงโดยไม่ต้อง compile ก่อน
    seed: "tsx prisma/seed.ts",
  },
});
