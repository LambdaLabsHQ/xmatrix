import { DesktopDownload } from "@/components/landing/desktop-download";
import { downloadPageMetadata } from "@/components/landing/download-page-view";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";

export const metadata = downloadPageMetadata("en");

export default function DownloadPage() {
  return (
    <div className="site-page">
      <Navbar locale="en" />
      <main>
        <DesktopDownload locale="en" />
      </main>
      <Footer locale="en" basePath="/download" />
    </div>
  );
}
