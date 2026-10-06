"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, FileText, Loader2 } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { xmatrixApiRequest, XMatrixApiError } from "@/lib/query/api-client";
import { loadGoogleDocPicker, openGoogleDocPicker, type GooglePickerConfiguration } from "@/lib/google-doc-picker";

export function GoogleDocFileSelection({ spaceId, token }: { spaceId: string; token: string }) {
  const [ready, setReady] = useState<{
    config: GooglePickerConfiguration; sdk: Awaited<ReturnType<typeof loadGoogleDocPicker>>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ id: string; name: string; url: string; kind?: "doc" | "sheet" } | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    mounted.current = true;
    setReady(null); setFile(null); setError(null); setBusy(false);
    void xmatrixApiRequest<GooglePickerConfiguration>({ url: WEB_PROXY_ROUTES.space_app_connection_google_picker(spaceId),
      token, signal: controller.signal }).then(async config => {
      const sdk = await loadGoogleDocPicker();
      if (active) setReady({ config, sdk });
    }).catch(error => { if (active) setError(error instanceof XMatrixApiError && error.status === 503
      ? "Google file selection is not configured yet. Documents created through xMatrix can still be used."
      : "File selection requires a Space admin and a configured Google connection."); });
    return () => {
      active = false; mounted.current = false;
      controller.abort(); request.current?.abort(); cancel.current?.(); cancel.current = null;
    };
  }, [spaceId, token]);

  const select = () => {
    if (!ready || busy) return;
    setBusy(true); setError(null); setFile(null);
    cancel.current = openGoogleDocPicker(ready.sdk, ready.config, {
      origin: window.location.origin,
      onCancel: () => { if (mounted.current) setBusy(false); },
      onError: message => { if (mounted.current) { setError(message); setBusy(false); } },
      onSelect: id => {
        const controller = new AbortController();
        request.current = controller;
        void xmatrixApiRequest<{ file: { id: string; name: string; url: string; kind?: "doc" | "sheet" } }>({
          url: WEB_PROXY_ROUTES.space_app_connection_google_picker(spaceId), method: "POST", token,
          body: { fileId: id }, signal: controller.signal,
        }).then(result => { if (mounted.current && !controller.signal.aborted) setFile(result.file); })
          .catch(() => { if (mounted.current && !controller.signal.aborted) {
            setError("This Space could not access that file. Choose the connected Google account, or reconnect Google.");
          } }).finally(() => { if (mounted.current && !controller.signal.aborted) setBusy(false); });
      },
    });
  };

  const readCommand = file ? file.kind === "sheet" ? `@google:read_sheet:${file.id} A1:T20` : `@google:read_doc:${file.id}` : "";
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Choose a Google Doc or Sheet using the Google account connected to this Space. This grants xMatrix access to that file.</p>
    <Button size="sm" variant="outline" disabled={!ready || busy} onClick={select}>
      {busy ? <Loader2 className="animate-spin" /> : <FileText />} {busy ? "Selecting file" : "Choose Google Doc or Sheet"}
    </Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {file ? <div className="space-y-2 text-sm">
      <a href={file.url} target="_blank" rel="noopener noreferrer" className="underline">{file.name}</a>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all">{readCommand}</code>
        <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard.writeText(readCommand)
          .catch(() => setError("Could not copy; select the command above."))} aria-label="Copy file read command"><Copy /> Copy</Button>
      </div>
      {file.kind === "sheet" ? <p className="text-xs text-muted-foreground">The command reads A1:T20 on the first worksheet. Change it to the exact worksheet and range you need before posting.</p> : null}
      <p className="text-xs text-muted-foreground">Post this command in the channel where the file should be read. Writes follow that channel&apos;s action policy.</p>
    </div> : null}
  </div>;
}
