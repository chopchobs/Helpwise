import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // ตั้ง dummy env ก่อน module load เพื่อกัน stripe.ts throw ตอน import
    // (stripe.ts เรียก createStripeClient() ที่ top-level ซึ่ง throw ถ้าไม่มี key)
    env: {
      STRIPE_SECRET_KEY: "sk_test_dummy_vitest",
      // DATABASE_URL ต้องตั้งเพื่อกัน prisma.ts throw ตอน stripe.ts import
      // (stripe.ts → prisma.ts → createPrismaClient() → throw ถ้าไม่มี DATABASE_URL)
      DATABASE_URL: "postgresql://dummy:dummy@localhost:5432/dummy_test",
      // REDIS_URL ต้องตั้งเพื่อกัน redis.ts throw ตอน stripe.ts import
      REDIS_URL: "redis://dummy:6379",
      NODE_ENV: "test",
    },
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
  },
});
