// Prisma 7 configuration file
// Supabase = standard PostgreSQL → ใช้ driver adapter @prisma/adapter-pg (node-postgres)
// Prisma 7: connection URL ต้องอยู่ที่นี่ (ไม่ใช่ใน schema.prisma datasource block)
// DATABASE_URL / DIRECT_URL ดึงจาก .env — ห้าม hardcode connection string
//   - DATABASE_URL: pooled connection (pgbouncer :6543) สำหรับ runtime
//   - DIRECT_URL:   direct connection (:5432) สำหรับ migrate (ต้องการ direct, ไม่ผ่าน pooler)
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrate: {
    async adapter() {
      const { PrismaPg } = await import("@prisma/adapter-pg");
      // migrate ใช้ direct connection (DIRECT_URL); fallback เป็น DATABASE_URL
      const connectionString =
        process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
      return new PrismaPg({ connectionString });
    },
  },
});
