import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./themes/materials.css";
import "./themes/wood.css";
import "./themes/site.css";
import { AuthProvider } from "@/lib/auth-context";
import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";
import { LiquidGlassLensDefs } from "@/components/ui/liquid-glass-lens";

const siteUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://xmatrix.sh");

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "xMatrix — Where people and AI agents work together",
  description:
    "Bring every agent, person, and workstream into one shared space—visible, coordinated, and under your control.",
  icons: {
    icon: [
      { url: "/icon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-48.png", type: "image/png", sizes: "48x48" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
      {
        url: "/favicon.ico",
        sizes: "16x16 32x32 48x48 64x64 128x128 256x256",
      },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "xMatrix",
    description:
      "Bring every agent, person, and workstream into one shared space—visible, coordinated, and under your control.",
    url: "https://xmatrix.sh",
    siteName: "xMatrix",
    type: "website",
    images: ["/android-chrome-512x512.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout(props: { children: React.ReactNode }) {
  const themeScript = `
    (() => {
      try {
        /* Wood is the single fixed application material. */
        const theme = "wood";
        document.documentElement.setAttribute("data-app-theme", theme);
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add("light");
        document.documentElement.style.colorScheme = "light";
        const desktopPlatform = window.xmatrixDesktop && window.xmatrixDesktop.platform;
        if (desktopPlatform) document.documentElement.setAttribute("data-desktop-platform", desktopPlatform);
      } catch {
        document.documentElement.setAttribute("data-app-theme", "wood");
        document.documentElement.classList.add("light");
        document.documentElement.style.colorScheme = "light";
      }
    })();
  `;

  return (
    <html
      lang="en"
      className="font-sans light"
      data-app-theme="wood"
      style={{ colorScheme: "light" }}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="site-canvas antialiased">
        <LiquidGlassFilter />
        <LiquidGlassLensDefs />
        <AuthProvider>{props.children}</AuthProvider>
      </body>
    </html>
  );
}
