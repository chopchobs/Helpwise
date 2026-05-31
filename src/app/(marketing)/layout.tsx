// Layout สำหรับ marketing route group (signup, landing, pricing)
// พื้นหลัง Soft White, center content กลางจอ
export default function MarketingLayout({
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
