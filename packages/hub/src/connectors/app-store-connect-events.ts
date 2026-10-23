import { sha256Hex } from "@xmatrix/protocol";
import { createSignedJsonReceiver } from "./delivery-proof";
import { connectorEvent, record, text } from "./event-format";

/*
 * App Store Connect webhooks: `x-apple-signature: hmacsha256=<hex>` is the
 * HMAC-SHA256 of the body with the webhook's secret. A payload names the
 * version, build upload or feedback that changed and never the app, and Apple
 * keeps one webhook per app, so the app is the `app` query parameter of the
 * URL the webhook was registered with (`id` is its App Store Connect id, for
 * the link). Without it the event reaches Channels subscribed to `*`.
 */

const BUNDLE = /^[a-z0-9][a-z0-9.-]{0,154}$/u;
const STATE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/* What a state means for whoever is waiting on it; unknown states are shown as Apple names them. */
const VERSION_NOTES: Record<string, string> = {
  WAITING_FOR_REVIEW: "submitted; waiting for App Review",
  IN_REVIEW: "App Review started",
  REJECTED: "App Review rejected it; review_messages reads why",
  METADATA_REJECTED: "App Review rejected the listing; the build can stay, and review_messages reads why",
  INVALID_BINARY: "Apple refused the build; upload a new one",
  DEVELOPER_REJECTED: "withdrawn from review",
  PENDING_DEVELOPER_RELEASE: "approved; waiting for you to release it",
  PENDING_APPLE_RELEASE: "approved; Apple releases it on its date",
  PROCESSING_FOR_DISTRIBUTION: "approved; being published",
  READY_FOR_DISTRIBUTION: "live on the App Store",
  READY_FOR_SALE: "live on the App Store",
  WAITING_FOR_EXPORT_COMPLIANCE: "waiting for export compliance answers",
};

const state = (value: unknown) => STATE.test(text(value)) ? text(value) : "";

export const receiveAppStoreConnectDelivery = createSignedJsonReceiver({
  name: "App Store Connect", secretField: "webhookSecret", proof: { header: "x-apple-signature", prefix: "hmacsha256=" },
}, async (delivery, payload) => {
  const data = record(payload.data);
  const type = text(data.type);
  const attributes = record(data.attributes);
  const named = (delivery.url.searchParams.get("app") ?? "").trim().toLowerCase();
  const app = BUNDLE.test(named) ? named : "";
  const appId = delivery.url.searchParams.get("id") ?? "";
  const url = /^\d{1,20}$/u.test(appId) ? `https://appstoreconnect.apple.com/apps/${appId}/distribution` : undefined;
  const id = /^[A-Za-z0-9._:-]{1,120}$/u.test(text(data.id)) ? text(data.id)
    : `sha256:${(await sha256Hex(`${app}\0${delivery.rawBody}`)).slice(0, 40)}`;
  const event = (feature: string, title: string, details: (string | undefined)[] = []) => ({ ok: true as const, events: [connectorEvent({
    eventId: `appstoreconnect:${id}`, sourceRef: `appstoreconnect:${app || "*"}`, feature,
    summary: `${app || "App Store Connect"}: ${title}`, provider: `App Store Connect · ${app || "app"}`, title, url, details })] });
  if (type === "appStoreVersionAppVersionStateUpdated") {
    const next = state(attributes.newValue), previous = state(attributes.oldValue);
    if (!next) return { ok: true, events: [] };
    return event("version", `Version state ${previous ? `${previous} → ` : ""}${next}`, [VERSION_NOTES[next]]);
  }
  if (type === "buildUploadStateUpdated") {
    const next = state(attributes.newState);
    if (!next) return { ok: true, events: [] };
    return event("build", `Build upload ${next}`, [next === "COMPLETE" ? "The build is processed and can be attached to a version."
      : next === "FAILED" ? "Apple could not process the upload; read the reason in App Store Connect." : undefined]);
  }
  if (type === "buildBetaDetailExternalBuildStateUpdated") {
    const next = state(attributes.newExternalBuildState), previous = state(attributes.oldExternalBuildState);
    return next ? event("beta", `TestFlight external build state ${previous ? `${previous} → ` : ""}${next}`) : { ok: true, events: [] };
  }
  if (type === "betaFeedbackScreenshotSubmissionCreated" || type === "betaFeedbackCrashSubmissionCreated") {
    return event("feedback", `TestFlight ${type === "betaFeedbackCrashSubmissionCreated" ? "crash" : "screenshot"} feedback received`);
  }
  /* Pings and event types no Channel can subscribe to are acknowledged and dropped. */
  return { ok: true, events: [] };
});
