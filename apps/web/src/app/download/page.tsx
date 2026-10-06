import type { Metadata } from "next";
import { DesktopDownload } from "@/components/landing/desktop-download";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";

export const metadata: Metadata = {
  title: "Download xMatrix",
  description: "Download xMatrix for macOS, Windows, and Android.",
};

export default function DownloadPage() {
  return (
    <div className="site-page">
      <Navbar />
      <main>
        <DesktopDownload />
      </main>
      <Footer />
    </div>
  );
}
