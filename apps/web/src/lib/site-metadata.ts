import type { Metadata } from "next";
import { shareImage } from "@/lib/site-url";

/** Canonical and sharing metadata name the same page at the public site origin. */
export function sitePageMetadata(path: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path, siteName: "xMatrix", type: "website", images: [shareImage] },
  };
}
