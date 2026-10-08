"use client";

import "./globals.css";
import "./themes/site.css";
import { AppFailureScreen } from "@/components/app-failure/app-failure-screen";

/** Replaces the root layout when it fails, so it brings its own document. */
export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="site-canvas antialiased">
        <AppFailureScreen {...props} />
      </body>
    </html>
  );
}
