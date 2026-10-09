import type { Metadata } from "next";
import { PasswordAccess } from "@/components/auth/password-access";

export const metadata: Metadata = { title: "Choose a password", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function ResetPasswordPage() { return <PasswordAccess reset />; }
