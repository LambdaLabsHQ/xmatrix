import type { Metadata } from "next";
import { DesktopDownload } from "@/components/landing/desktop-download";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";

export const metadata: Metadata = {
  title: "Download xMatrix for macOS, Windows and Android",
  description: "Download the xMatrix desktop app for macOS (Apple Silicon and Intel) and Windows, or the Android APK, to follow and answer your AI coding agents from anywhere.",
  alternates: { canonical: "/download" },
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
