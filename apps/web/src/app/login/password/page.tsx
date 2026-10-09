import type { Metadata } from "next";
import { PasswordAccess } from "@/components/auth/password-access";

export const metadata: Metadata = { title: "Sign in with password", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function PasswordLoginPage() { return <PasswordAccess />; }
