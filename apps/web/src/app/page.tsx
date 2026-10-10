import type { Metadata } from "next";
import { Navbar } from "@/components/shared/navbar";
import { Hero } from "@/components/landing/hero";
import { QuickStart } from "@/components/landing/quick-start";
import { HowItWorks } from "@/components/landing/how-it-works";
import { FirstPage } from "@/components/landing/first-page";
import { Connectors } from "@/components/landing/connectors";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/footer";

export const metadata: Metadata = {
  title: "xMatrix — Living pages maintained by your AI agents",
  description: "Talk with Claude Code, Codex and your team. Turn conversations into living pages of decisions, open work and next steps, then keep them current together.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "xMatrix — Living pages maintained by your AI agents",
    description: "Talk with your team. Your AI agents keep decisions, open work and next steps current in Pages.",
    url: "/",
    type: "website",
    images: ["/android-chrome-512x512.png"],
  },
};

export default function Home() {
  return (
    <div className="site-page">
      <Navbar />
      <Hero />
      <QuickStart />
      <HowItWorks />
      <FirstPage />
      <Connectors />
      <Pricing />
      <Footer />
    </div>
  );
}
