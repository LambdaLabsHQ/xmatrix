import { Home, homeMetadata } from "@/components/landing/home";

export const metadata = homeMetadata("zh");

export default function ChineseHomePage() {
  return <Home locale="zh" />;
}
