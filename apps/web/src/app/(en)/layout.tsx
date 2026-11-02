import Document from "@/app/document";

export { metadata, viewport } from "@/app/document";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <Document lang="en">{children}</Document>;
}
