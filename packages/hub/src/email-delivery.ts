import { EmailMessage } from "cloudflare:email";

import { appOrigin } from "./deployment-origins";
import type { Env } from "./types";

/**
 * Cloudflare Email Sending for the Hub: login codes and Space invites build one
 * MIME message here and share one reading of a provider configuration failure.
 */

export const EMAIL_DELIVERY_CONFIGURATION_ERROR = "email_delivery_configuration_error";

const CLOUDFLARE_EMAIL_CONFIGURATION_ERROR_CODES = new Set([
  "E_RECIPIENT_NOT_ALLOWED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_SENDER_NOT_VERIFIED",
]);

type EmailDeliveryErrorDetails = {
  providerCode?: string;
  providerMessage: string;
  causeCode?: string;
  causeMessage?: string;
};

export class EmailDeliveryConfigurationError extends Error {
  readonly code = EMAIL_DELIVERY_CONFIGURATION_ERROR;
  readonly providerCode?: string;
  readonly providerMessage: string;
  readonly causeCode?: string;
  readonly causeMessage?: string;

  constructor(details: EmailDeliveryErrorDetails) {
    super("Email delivery is not configured for login codes.");
    this.name = "EmailDeliveryConfigurationError";
    this.providerCode = details.providerCode;
    this.providerMessage = details.providerMessage;
    this.causeCode = details.causeCode;
    this.causeMessage = details.causeMessage;
  }
}

function getEmailFromAddress(env: Env): string {
  return (
    env.XMATRIX_EMAIL_FROM?.trim() ||
    env.XMATRIX_INVITE_EMAIL_FROM?.trim() ||
    `noreply@${new URL(appOrigin(env)).hostname}`
  );
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entry = (value as Record<string, unknown>)[property];
  return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
}

function emailDeliveryErrorDetails(error: unknown): EmailDeliveryErrorDetails {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  return {
    providerCode: stringProperty(error, "code"),
    providerMessage:
      error instanceof Error ? error.message : String(error || "Cloudflare Email Sending failed"),
    causeCode: stringProperty(cause, "code"),
    causeMessage: cause instanceof Error ? cause.message : stringProperty(error, "cause"),
  };
}

function isEmailDeliveryConfigurationError(error: unknown): boolean {
  const details = emailDeliveryErrorDetails(error);
  if (
    (details.providerCode && CLOUDFLARE_EMAIL_CONFIGURATION_ERROR_CODES.has(details.providerCode)) ||
    (details.causeCode && CLOUDFLARE_EMAIL_CONFIGURATION_ERROR_CODES.has(details.causeCode))
  ) {
    return true;
  }

  return /sender domain not verified|recipient not in allowed list|domain not available for sending/i.test(
    details.providerMessage
  );
}

export function loginEmailErrorLog(error: unknown) {
  if (error instanceof EmailDeliveryConfigurationError) {
    return {
      code: error.code,
      providerCode: error.providerCode,
      providerMessage: error.providerMessage,
      causeCode: error.causeCode,
      causeMessage: error.causeMessage,
    };
  }

  const details = emailDeliveryErrorDetails(error);
  return {
    code: stringProperty(error, "code"),
    message: error instanceof Error ? error.message : String(error || "Failed to send OTP"),
    providerCode: details.providerCode,
    causeCode: details.causeCode,
    causeMessage: details.causeMessage,
  };
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return btoa(binary);
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeHeaderValue(value: string): string {
  const sanitized = sanitizeHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(sanitized)) {
    return sanitized;
  }

  return `=?UTF-8?B?${base64EncodeUtf8(sanitized)}?=`;
}

function sanitizeEmailAddress(value: string): string {
  return value.replace(/[\r\n<>]+/g, "").trim();
}

function formatEmailAddress(name: string, email: string): string {
  return `${encodeHeaderValue(name)} <${sanitizeEmailAddress(email)}>`;
}

function buildMimeEmail(input: {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `xmatrix-${crypto.randomUUID()}`;
  const lines = [
    `From: ${formatEmailAddress(input.fromName, input.fromEmail)}`,
    `To: ${sanitizeEmailAddress(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64EncodeUtf8(input.text)),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64EncodeUtf8(input.html)),
    `--${boundary}--`,
    "",
  ];

  return lines.join("\r\n");
}

export async function sendEmail(
  env: Env,
  to: string,
  message: { subject: string; text: string; html: string }
) {
  if (!env.SEND_EMAIL) {
    throw new EmailDeliveryConfigurationError({
      providerMessage: "Cloudflare Email Sending binding SEND_EMAIL is not configured",
    });
  }

  const fromAddress = getEmailFromAddress(env);
  const raw = buildMimeEmail({
    fromName: "xMatrix",
    fromEmail: fromAddress,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  try {
    await env.SEND_EMAIL.send(new EmailMessage(fromAddress, to, raw));
  } catch (error) {
    if (isEmailDeliveryConfigurationError(error)) {
      throw new EmailDeliveryConfigurationError(emailDeliveryErrorDetails(error));
    }
    throw error;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
