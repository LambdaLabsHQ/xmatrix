"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useEffect, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { ConnectorCopyLine, ConnectorRow, ConnectorRows } from "./connector-page";
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
  return <div>
    <button type="button" className={actionClass({ variant: "secondary", size: "sm" })} disabled={!ready || busy} onClick={select}>
      {busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />} {busy ? "Selecting file" : "Choose a Doc or Sheet"}
    </button>
    {error ? <p role="alert" className="mt-2 text-[13px] text-destructive">{error}</p> : null}
    {file ? <ConnectorRows className="mt-2">
      <ConnectorRow title={<a href={file.url} target="_blank" rel="noopener noreferrer" className="underline">{file.name}</a>}
        meta={file.kind === "sheet"
          ? "Post this in the channel that should read it. It reads A1:T20 of the first worksheet; change the range to the one you need."
          : "Post this in the channel that should read it. Writes follow that channel's permissions."}>
        <div className="mt-1.5"><ConnectorCopyLine value={readCommand} label="file read command" /></div>
      </ConnectorRow>
    </ConnectorRows> : null}
  </div>;
}
