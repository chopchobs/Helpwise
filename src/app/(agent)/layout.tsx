// Layout สำหรับ agent route group — app ภายในสำหรับ agent
// พื้นหลัง Soft White, center card กลางจอ
export default function AgentLayout({
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
