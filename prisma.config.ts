// Prisma 7 configuration file
// แยก connection 2 เส้นตาม Supabase:
//   - runtime PrismaClient: ใช้ driver adapter @prisma/adapter-pg + DATABASE_URL
//     (pooled, pgbouncer :6543) — ดู src/lib/prisma.ts
//   - migrate CLI: ใช้ datasource.url + DIRECT_URL (direct :5432, ไม่ผ่าน pooler)
//     เพราะ migration ต้องการ direct connection
// ทุกค่าดึงจาก .env — ห้าม hardcode connection string
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  // migrate / introspect ใช้ direct connection; fallback เป็น DATABASE_URL
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
