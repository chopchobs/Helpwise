// ลิงก์ปลายทางของ landing — env override ได้, มี fallback ที่ใช้งานได้จริง (ไม่มี dead "#")
// acme = demo tenant (hardcode ตรงนี้ ไม่ import จาก src/lib/demo.ts เพราะมี server-only code ห้ามเข้า client bundle)
const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com";

export const GITHUB_URL = "https://github.com/chopchobs/Helpwise";
export const GITHUB_README_URL = "https://github.com/chopchobs/Helpwise#readme";
export const DEMO_URL =
  process.env.NEXT_PUBLIC_DEMO_URL ?? `https://acme.${ROOT_DOMAIN}/demo`; // ปุ่ม Try live demo
export const SIGNIN_URL = process.env.NEXT_PUBLIC_SIGNIN_URL ?? "/signin"; // ปุ่ม Sign in (workspace picker)
