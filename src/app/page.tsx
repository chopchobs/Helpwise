import LandingNav from "@/components/landing/LandingNav";
import Hero from "@/components/landing/Hero";
import TechStrip from "@/components/landing/TechStrip";
import AiSection from "@/components/landing/AiSection";
import UnderTheHood from "@/components/landing/UnderTheHood";
import FinalCta from "@/components/landing/FinalCta";
import LandingFooter from "@/components/landing/LandingFooter";
import { resolveDemoUrl } from "@/lib/demo-url";

// Landing page — render ที่ "/" ของทุก host (รวม tenant subdomain) — server component
// demoUrl resolve ตาม host: subdomain → "/demo" (อยู่ tenant เดิม), root → acme fallback
export default async function Home() {
  const demoUrl = await resolveDemoUrl();

  return (
    <div className="flex flex-1 flex-col bg-background">
      <LandingNav demoUrl={demoUrl} />
      <main className="flex-1">
        <Hero demoUrl={demoUrl} />
        <TechStrip />

        <AiSection />
        <UnderTheHood />

        <FinalCta demoUrl={demoUrl} />
      </main>
      <LandingFooter />
    </div>
  );
}
