import type { Metadata } from "next";
import { Navbar } from "@/components/shared/navbar";
import { Hero } from "@/components/landing/hero";
import { QuickStart } from "@/components/landing/quick-start";
import { ProblemStatement } from "@/components/landing/problem-statement";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Connectors } from "@/components/landing/connectors";
import { AgentMaterials } from "@/components/landing/agent-materials";
import { Architecture } from "@/components/landing/architecture";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/footer";

// Additive agentic quick start: a hero CTA plus one extra section. Set to
// false to hide both and render the homepage exactly as before.
const SHOW_AGENT_QUICK_START: boolean = true;

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <div className="site-page">
      <Navbar />
      <Hero />
      {SHOW_AGENT_QUICK_START && <QuickStart />}
      <HowItWorks />
      <Connectors />
      <AgentMaterials />
      <ProblemStatement />
      <Architecture />
      <Pricing />
      <Footer />
    </div>
  );
}
