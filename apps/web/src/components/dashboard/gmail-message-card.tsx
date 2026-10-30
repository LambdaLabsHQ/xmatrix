"use client";

import { useState } from "react";
import { ArrowUpRight, Paperclip, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { GmailMessage } from "@/lib/gmail-message";
import { statusInkClass } from "@/components/ui/status-tone";

const BODY_FOLD = 600;
const LINK_FOLD = 4;

function receivedAt(date: string): { label: string; title: string } {
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return { label: date, title: date };
  const when = new Date(time);
  const sameYear = when.getFullYear() === new Date().getFullYear();
  return {
    label: when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      ...(sameYear ? {} : { year: "numeric" }) }),
    title: when.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
  };
}

function SenderBadge({ message }: { message: GmailMessage }) {
  if (message.sender === "unknown") return null;
  const [Icon, tone, label] = message.sender === "verified" ? [ShieldCheck, "secondary", "Verified sender"] as const
    : message.sender === "failed" ? [ShieldAlert, "alert", `Failed ${message.failedChecks.join(" · ")} — may be forged`] as const
      : [ShieldQuestion, "attention", "Sender not verified"] as const;
  return <span className={statusInkClass(tone, "app-gmail-card-sender")} title={`Gmail checks: ${message.senderChecks}`}>
    <Icon aria-hidden="true" />{label}
  </span>;
}

/**
 * One Gmail message drawn as an email: who sent it and when, the subject, whether Gmail believed the sender,
 * the text and its links. Plain text only — mail is untrusted, so nothing in it loads media or renders Markdown,
 * and a link opens only when the reader clicks it, without a referrer.
 */
export function GmailMessageCard({ message }: { message: GmailMessage }) {
  const [bodyOpen, setBodyOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const sender = message.fromName || message.fromAddress;
  const initial = (sender.match(/[\p{L}\p{N}]/u)?.[0] ?? "@").toUpperCase();
  const when = receivedAt(message.date);
  const longBody = message.body.length > BODY_FOLD;
  const links = linksOpen ? message.links : message.links.slice(0, LINK_FOLD);
  return <article className="app-gmail-card" data-testid="gmail-message-card">
    <header className="app-gmail-card-head">
      <span className="app-gmail-card-avatar" aria-hidden="true">{initial}</span>
      <div className="app-gmail-card-who">
        <p className="app-gmail-card-from">
          <span className="app-gmail-card-name">{sender}</span>
          {when.label && <time className="app-gmail-card-date" title={when.title}>{when.label}</time>}
        </p>
        <p className="app-gmail-card-meta">
          {message.fromName && <span>{message.fromAddress}</span>}
          {(message.mailbox || message.to) && <span>to {message.mailbox || message.to}</span>}
        </p>
      </div>
    </header>
    <h4 className="app-gmail-card-subject">{message.subject || "(no subject)"}</h4>
    <SenderBadge message={message} />
    {message.body ? <div className={`app-gmail-card-body${longBody && !bodyOpen ? " app-gmail-card-body-folded" : ""}`}>
      {message.body}{message.bodyTruncated && bodyOpen && <span className="app-gmail-card-note"> … truncated</span>}
    </div> : <p className="app-gmail-card-note">No text in this message</p>}
    {longBody && <button type="button" className="app-gmail-card-toggle" onClick={() => setBodyOpen(open => !open)}>
      {bodyOpen ? "Show less" : "Show full message"}
    </button>}
    {message.incomplete && <p className="app-gmail-card-note"><Paperclip aria-hidden="true" />Some parts of this message are not shown</p>}
    {message.links.length > 0 && <footer className="app-gmail-card-links">
      {links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer" className="app-gmail-card-link" title={link.url}>
        <span className="app-gmail-card-link-label">{link.label || new URL(link.url).pathname.replace(/^\/$/u, "") || link.host}</span>
        <span className="app-gmail-card-link-host">{link.host}</span>
        <ArrowUpRight aria-hidden="true" />
      </a>)}
      {message.links.length > LINK_FOLD && <button type="button" className="app-gmail-card-toggle"
        onClick={() => setLinksOpen(open => !open)}>
        {linksOpen ? "Fewer links" : `${message.links.length - LINK_FOLD} more links`}
      </button>}
    </footer>}
  </article>;
}
