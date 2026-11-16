import { Home, homeMetadata } from "@/components/landing/home";

export const metadata = homeMetadata("en");

export default function HomePage() {
  return <Home locale="en" />;
}
