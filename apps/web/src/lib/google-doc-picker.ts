/** Google grants a separate, browser-owned selection token. Space connection tokens never enter this module. */
export interface GooglePickerConfiguration { clientId: string; apiKey: string; appId: string }
interface Picker { setVisible(value: boolean): void; dispose(): void }
interface PickerView { setMimeTypes(value: string): PickerView }
interface PickerBuilder {
  setDeveloperKey(value: string): PickerBuilder;
  setAppId(value: string): PickerBuilder;
  setOAuthToken(value: string): PickerBuilder;
  setOrigin(value: string): PickerBuilder;
  addView(view: PickerView): PickerBuilder;
  setCallback(callback: (result: { action?: string; docs?: { id?: unknown }[] }) => void): PickerBuilder;
  build(): Picker;
}
interface GoogleSdk {
  accounts: { oauth2: { initTokenClient(config: {
    client_id: string; scope: string; include_granted_scopes: false;
    callback: (response: { access_token?: string; scope?: string; token_type?: string; expires_in?: number; error?: string }) => void;
    error_callback: () => void;
  }): { requestAccessToken(options: { prompt: string }): void } } };
  picker: { View: new (id: string) => PickerView; ViewId: { DOCS: string };
    PickerBuilder: new () => PickerBuilder; Action: { PICKED: string; CANCEL: string } };
}
interface GoogleWindow {
  google?: GoogleSdk;
  gapi?: { load(name: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void };
}

let libraries: Promise<GoogleSdk> | undefined;

export function loadGoogleDocPicker(): Promise<GoogleSdk> {
  const root = window as unknown as GoogleWindow;
  if (root.google?.accounts?.oauth2 && root.google?.picker) return Promise.resolve(root.google);
  if (libraries) return libraries;
  const load = (src: string) => new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => fail(), 30_000);
    const fail = () => { window.clearTimeout(timer); script.remove(); reject(new Error("Google file selection could not load")); };
    script.src = src;
    script.async = true;
    script.onload = () => { window.clearTimeout(timer); resolve(); };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  libraries = Promise.all([
    root.gapi ? Promise.resolve() : load("https://apis.google.com/js/api.js"),
    root.google?.accounts?.oauth2 ? Promise.resolve() : load("https://accounts.google.com/gsi/client"),
  ]).then(() => new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error("Google file selection could not load"));
    if (!root.gapi) return failed();
    root.gapi.load("picker", { callback: resolve, onerror: failed, timeout: 30_000, ontimeout: failed });
  })).then(() => {
    if (!root.google?.accounts?.oauth2 || !root.google?.picker) throw new Error("Google file selection could not load");
    return root.google;
  }).catch(error => { libraries = undefined; throw error; });
  return libraries;
}

/** Must be called directly from a click, after loading, so Google can open its own account chooser. */
export function openGoogleDocPicker(sdk: GoogleSdk, config: GooglePickerConfiguration, input: {
  origin: string; onSelect: (id: string) => void; onCancel: () => void; onError: (message: string) => void;
}): () => void {
  const scope = "https://www.googleapis.com/auth/drive.file";
  let closed = false;
  let granted = false;
  let picker: Picker | undefined;
  const close = () => {
    closed = true;
    window.clearTimeout(timer);
    picker?.dispose();
    picker = undefined;
  };
  const fail = (message: string) => { if (!closed) { close(); input.onError(message); } };
  const timer = window.setTimeout(() => fail("Google file selection timed out; try again"), 5 * 60_000);
  try {
    const client = sdk.accounts.oauth2.initTokenClient({ client_id: config.clientId, scope,
      include_granted_scopes: false,
      error_callback: () => fail("Google authorization was cancelled or could not open"),
      callback: response => {
        if (closed || granted) return;
        if (response.error || !response.access_token || response.access_token.length > 16_384 || /\s/u.test(response.access_token) ||
            response.token_type?.toLowerCase() !== "bearer" || response.scope?.trim() !== scope ||
            !Number.isFinite(Number(response.expires_in)) || Number(response.expires_in) <= 0 || Number(response.expires_in) > 86_400) {
          fail("Google did not grant the requested per-file permission"); return;
        }
        granted = true;
        try {
          const view = new sdk.picker.View(sdk.picker.ViewId.DOCS).setMimeTypes("application/vnd.google-apps.document,application/vnd.google-apps.spreadsheet");
          picker = new sdk.picker.PickerBuilder().setDeveloperKey(config.apiKey).setAppId(config.appId)
            .setOAuthToken(response.access_token).setOrigin(input.origin).addView(view).setCallback(result => {
              if (closed) return;
              if (result.action === sdk.picker.Action.CANCEL) { close(); input.onCancel(); return; }
              if (result.action !== sdk.picker.Action.PICKED) return;
              const id = result.docs?.[0]?.id;
              if (typeof id !== "string" || !/^[A-Za-z0-9_-]{10,200}$/u.test(id)) {
                fail("Google did not return a valid file selection"); return;
              }
              close(); input.onSelect(id);
            }).build();
          picker.setVisible(true);
        } catch { fail("Google file selection could not open"); }
      },
    });
    client.requestAccessToken({ prompt: "select_account consent" });
  } catch { fail("Google authorization could not open"); }
  return close;
}
