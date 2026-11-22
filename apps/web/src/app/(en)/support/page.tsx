import { SupportPageView, supportPageMetadata } from "@/components/support/support-page";

export const metadata = supportPageMetadata("en");

export default function SupportPage() {
  return <SupportPageView locale="en" />;
}
