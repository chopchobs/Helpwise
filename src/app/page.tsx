import LandingNav from "@/components/landing/LandingNav";
import Hero from "@/components/landing/Hero";
import TechStrip from "@/components/landing/TechStrip";
import AiSection from "@/components/landing/AiSection";
import UnderTheHood from "@/components/landing/UnderTheHood";
import FinalCta from "@/components/landing/FinalCta";
import LandingFooter from "@/components/landing/LandingFooter";

// Landing page (root domain, ไม่มี tenant context) — server component
export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <LandingNav />
      <main className="flex-1">
        <Hero />
        <TechStrip />

        <AiSection />
        <UnderTheHood />

        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
