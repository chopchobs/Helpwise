// Layout สำหรับ portal route group — portal สาธารณะสำหรับลูกค้า
// แยก layout จาก agent เพื่อรองรับ tenant branding ในอนาคต (Phase: Custom Branding)
// TODO Phase (Tenant Branding): ดึง logoUrl + accent color จาก Tenant.settings แล้ว inject CSS variable
export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#F7F9FB] flex flex-col items-center justify-center px-4 py-12">
      {children}
    </div>
  );
}
