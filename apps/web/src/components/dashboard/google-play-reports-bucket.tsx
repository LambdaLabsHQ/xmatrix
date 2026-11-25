"use client";

import { useState } from "react";
import { CloudDownload, ExternalLink, Loader2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { noticeClass } from "@/components/ui/status-tone";
import { requestPlayConsoleBucket } from "@/lib/extension-embed";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CredentialValueForm, useCredentialStore, type CredentialStoreInput } from "./connector-credentials";
import { ConnectorAction, ConnectorFold, ConnectorRow, ConnectorRows } from "./connector-page";

const PLAY_CONSOLE_URL = "https://play.google.com/console/developers";

/**
 * Google Play Console bulk reports configuration (Cloud Storage bucket ID and
 * optional Service Account fallback). Offers one-click bucket detection from an
 * open Chrome Play Console tab via the xMatrix Chrome extension (plain bucket ID
 * only, never Google cookies), with manual paste always available.
 */
export function GooglePlayReportsBucket({ credentials }: { credentials: CredentialStoreInput }) {
  const { view, save, stored } = useCredentialStore(credentials);
  const [detecting, setDetecting] = useState(false);
  const [editingBucket, setEditingBucket] = useState(false);
  const [editingSa, setEditingSa] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ tone: "settled" | "attention"; text: string; link?: { href: string; label: string } } | null>(null);

  const bucketField = credentials.connector.credentials?.find((field) => field.id === "reportsBucket");
  const saField = credentials.connector.credentials?.find((field) => field.id === "reportsServiceAccount");
  const savedBucket = view.data?.plain?.reportsBucket ?? "";
  const busy = detecting || save.isPending || view.isFetching;
  const error = userErrorMessage(save.error, "Couldn't save the credentials")
    ?? userErrorMessage(view.error, "Couldn't load the credentials");

  async function saveBucket(bucket: string) {
    setNotice(null);
    await save.mutateAsync({ fields: { reportsBucket: bucket } });
    setCandidates([]);
    setEditingBucket(false);
    setNotice({ tone: "settled", text: `Saved ${bucket} for @googleplay:store_reports.` });
  }

  async function syncFromChrome() {
    setDetecting(true);
    setNotice(null);
    setCandidates([]);
    try {
      const result = await requestPlayConsoleBucket();
      if (result.status === "found") {
        if (result.buckets.length === 1) {
          await saveBucket(result.buckets[0]!);
          return;
        }
        setCandidates(result.buckets);
        setNotice({ tone: "settled", text: `Found ${result.buckets.length} Play Console buckets. Choose one to save.` });
        return;
      }
      if (result.status === "not-found") {
        setNotice({
          tone: "attention",
          text: "No pubsite_prod_rev_… bucket was visible on your Play Console tab. Open Download reports (any report tab), then click Sync again.",
          link: { href: result.downloadReportsUrl ?? PLAY_CONSOLE_URL, label: "Open Download reports" },
        });
        return;
      }
      if (result.status === "no-tab") {
        setNotice({
          tone: "attention",
          text: "Open Google Play Console → Download reports in a Chrome tab, then click Sync again (or sync directly from the xMatrix side panel on that tab).",
          link: { href: PLAY_CONSOLE_URL, label: "Open Play Console" },
        });
        return;
      }
      if (result.status === "no-permission") {
        setNotice({
          tone: "attention",
          text: "To sync without granting all-sites access, open the xMatrix side panel on your Play Console → Download reports tab (or right-click there → Sync Google Play reports bucket to xMatrix).",
        });
        return;
      }
      setNotice({
        tone: "attention",
        text: "Install the xMatrix Chrome extension to sync from a Play Console tab in one click, or paste the Cloud Storage URI manually.",
      });
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <ConnectorRows>
        <ConnectorRow
          title={bucketField?.label ?? "Reports Cloud Storage bucket (optional)"}
          meta={savedBucket ? <span className="font-mono text-[12.5px]">{savedBucket}</span> : "Not set"}
          trailing={editingBucket ? null : (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void syncFromChrome()}
                className={actionClass({ variant: "secondary", size: "sm" })}
              >
                {detecting ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <CloudDownload className="size-3.5" />}
                {detecting ? "Checking Play Console" : "Sync from Play Console tab"}
              </button>
              <ConnectorAction disabled={busy} onClick={() => { setNotice(null); setEditingBucket(true); }}>
                {savedBucket ? "Change" : "Enter manually"}
              </ConnectorAction>
            </div>
          )}
        >
          {candidates.length > 1 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {candidates.map((bucket) => (
                <button
                  key={bucket}
                  type="button"
                  disabled={busy}
                  onClick={() => void saveBucket(bucket)}
                  className={actionClass({ variant: "secondary", size: "sm" })}
                >
                  <span className="font-mono text-[12px]">{bucket}</span>
                </button>
              ))}
            </div>
          ) : null}
          {editingBucket && bucketField ? (
            <CredentialValueForm
              field={bucketField}
              busy={busy}
              saving={save.isPending}
              submitLabel="Save"
              autoFocus
              plain
              initialValue={savedBucket}
              className="mt-2 flex flex-wrap items-center gap-2"
              save={(value) => saveBucket(value)}
            >
              <ConnectorAction onClick={() => setEditingBucket(false)}>Cancel</ConnectorAction>
              <p className="basis-full text-[12px] leading-[1.45] text-muted-foreground">
                Paste either <code className="font-mono">pubsite_prod_rev_…</code> or the full{" "}
                <code className="font-mono">gs://pubsite_prod_rev_…</code> URI from Play Console → Download reports → Copy Cloud Storage URI.
              </p>
            </CredentialValueForm>
          ) : null}
        </ConnectorRow>
      </ConnectorRows>

      {notice ? (
        <p className={noticeClass(notice.tone, "text-[13px] leading-[1.45]")}>
          {notice.text}
          {notice.link ? (
            <>
              {" "}
              <a
                href={notice.link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold underline underline-offset-4"
              >
                {notice.link.label}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-[13px] font-medium text-destructive">{error}</p> : null}

      {saField ? (
        <ConnectorFold summary={stored.has(saField.id) ? "Service account fallback (saved)" : "Service account fallback (optional)"}>
          <div className="pt-2">
            <ConnectorRows>
              <ConnectorRow
                title={saField.label}
                meta={stored.has(saField.id) ? "Saved" : "Optional — needed only when the connected Google Play OAuth token does not yet include Cloud Storage read access."}
                trailing={editingSa ? null : (
                  <ConnectorAction disabled={busy} onClick={() => setEditingSa(true)}>
                    {stored.has(saField.id) ? "Replace" : "Add"}
                  </ConnectorAction>
                )}
              >
                {editingSa ? (
                  <CredentialValueForm
                    field={saField}
                    busy={busy}
                    saving={save.isPending}
                    submitLabel="Save"
                    autoFocus
                    className="mt-2 flex flex-wrap items-center gap-2"
                    save={(value) => save.mutateAsync({ fields: { [saField.id]: value } }).then(() => setEditingSa(false))}
                  >
                    <ConnectorAction onClick={() => setEditingSa(false)}>Cancel</ConnectorAction>
                    {saField.description ? (
                      <p className="basis-full text-[12px] leading-[1.45] text-muted-foreground">{saField.description}</p>
                    ) : null}
                  </CredentialValueForm>
                ) : null}
              </ConnectorRow>
            </ConnectorRows>
          </div>
        </ConnectorFold>
      ) : null}
    </div>
  );
}
