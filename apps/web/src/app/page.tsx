import type { Metadata } from "next";
import { Navbar } from "@/components/shared/navbar";
import { Hero } from "@/components/landing/hero";
import { QuickStart } from "@/components/landing/quick-start";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Connectors } from "@/components/landing/connectors";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/footer";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <div className="site-page">
      <Navbar />
      <Hero />
      <QuickStart />
      <HowItWorks />
      <Connectors />
      <Pricing />
      <Footer />
    </div>
  );
}
