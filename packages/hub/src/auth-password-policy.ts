import { escapeHtml } from "./email-delivery";

/** Passwords authenticate existing verified identities; they never create one. */
export const VERIFIED_PASSWORD_OPTIONS = {
  enabled: true,
  disableSignUp: true,
  requireEmailVerification: true,
  minPasswordLength: 16,
  maxPasswordLength: 128,
  resetPasswordTokenExpiresIn: 600,
  revokeSessionsOnPasswordReset: true,
} as const;

export function passwordResetEmail(url: string) {
  return {
    subject: "Choose your xMatrix password",
    text: `Use this link to choose a password for your xMatrix account:\n\n${url}\n\nThis link expires in 10 minutes. If you did not request it, ignore this email.`,
    html: `<p>Use the link below to choose a password for your xMatrix account.</p><p><a href="${escapeHtml(url)}">Choose password</a></p><p>This link expires in 10 minutes. If you did not request it, ignore this email.</p>`,
  };
}
