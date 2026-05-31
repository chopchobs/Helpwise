// AuthCard — wrapper card กลางจอสำหรับหน้า auth ทุกหน้า
interface AuthCardProps {
  children: React.ReactNode;
}

export default function AuthCard({ children }: AuthCardProps) {
  return (
    <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-[#E4E7EB] p-8">
      {children}
    </div>
  );
}
