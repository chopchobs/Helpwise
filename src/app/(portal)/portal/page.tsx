/**
 * /portal — entry point ของ portal ลูกค้า
 *
 * เดิมไม่มีไฟล์นี้ → contact ที่พิมพ์ /portal ตรง ๆ เจอ 404
 * redirect ไปหน้ารายการคำขอ; ถ้ายังไม่ login หน้ารายการจะพาไป /portal/login เอง (401 handling)
 */

import { redirect } from "next/navigation";

export default function PortalIndexPage(): never {
  redirect("/portal/tickets");
}
