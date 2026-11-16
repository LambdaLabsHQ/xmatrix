"use client";

import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, LogIn } from "lucide-react";
import {
  parseSettingAddress, WEB_PROXY_ROUTES, type SettingControl, type SettingDescriptor, type SettingWriter,
} from "@xmatrix/protocol";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CredentialValueForm } from "./connector-credentials";
import { HarnessSignInSection } from "./harness-sign-in";

/** While a card is open, everyone's card notices a setting made elsewhere (the Apps page, another card). */
const OPEN_REFRESH_MS = 30_000;

/** A setting as the card's viewer sees it, with the value its Agent suggested for a plain one. */
type CardSetting = SettingDescriptor & { proposed?: string };

/** The card as the Hub reads it for this viewer (docs/design/settings-cards.md). */
interface CardView {
  spaceId: string;
  settings: CardSetting[];
  satisfied: boolean;
  askedBy?: string;
  resumeExecutionId?: string;
}

type Make = (address: string, value: string) => Promise<unknown>;

interface ControlProps {
  setting: CardSetting;
  busy: boolean;
  make: Make;
  /** Reads the card again, for a control that finishes outside it. */
  refresh: () => void;
  suggestedBy?: string;
  token: string;
  userId: string;
}

/**
 * How each control asks for its setting. A card names settings only by
 * address; what to draw comes from the setting's control, never from the
 * card or its domain, so no message can lay out its own "paste your key
 * here" box.
 */
const CONTROLS: Record<SettingControl, (props: ControlProps) => ReactNode> = {
  text: ({ setting, busy, make, suggestedBy }) => (
    <CredentialValueForm field={{ id: setting.address, label: setting.label }} busy={busy} saving={busy} plain
      submitLabel={setting.proposed ? "Confirm and check" : "Save and check"} variant="primary"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2" initialValue={setting.proposed ?? setting.value}
      key={setting.proposed ?? setting.value ?? ""} save={(value) => make(setting.address, value)}>
      {setting.proposed ? (
        <p className="basis-full text-[12px] text-muted-foreground">
          Suggested by {suggestedBy || "the Agent"}; it is saved only when you confirm.
        </p>
      ) : null}
    </CredentialValueForm>
  ),
  secret: ({ setting, busy, make }) => (
    <CredentialValueForm field={{ id: setting.address, label: setting.label }} busy={busy} saving={busy} submitLabel="Save"
      variant="primary" className="flex min-w-0 flex-1 flex-wrap items-center gap-2" save={(value) => make(setting.address, value)} />
  ),
  "sign-in": (props) => <SignInControl {...props} />,
  connect: ({ setting }) => setting.href ? (
    <a className={actionClass({ variant: "primary", size: "sm" })} href={setting.href}>Connect {setting.scope}</a>
  ) : null,
  grant: ({ setting, busy, make }) => (
    <button type="button" disabled={busy} className={actionClass({ variant: "primary", size: "sm" })}
      onClick={() => void make(setting.address, "granted").catch(() => undefined)}>Allow</button>
  ),
  "harness-sign-in": ({ setting, refresh, token, userId }) => {
    const [machineId, harness] = parseSettingAddress(setting.address)?.parts ?? [];
    return machineId && harness ? (
      <HarnessSignInSection registration={{ key: { ownerUserId: userId, machineId, harness }, machineName: setting.scope }}
        token={token} userId={userId} bare signInLabel={setting.label} onSignedIn={refresh} />
    ) : null;
  },
};

/** A web session: the desktop app signs in on the service's own page; elsewhere a signed-in page's Cookie header is pasted. */
function SignInControl({ setting, busy, make }: ControlProps) {
  const bridge = getDesktopBridge();
  const signIn = useMutation({
    mutationKey: ["settings-card-sign-in", setting.address],
    mutationFn: async () => {
      const outcome = await bridge!.serviceSignIn!(setting.service!, { fresh: false });
      if (outcome.status === "signed-in") await make(setting.address, outcome.session);
    },
  });
  const error = userErrorMessage(signIn.error, "Couldn't sign in to the service");
  if (setting.service && bridge?.serviceSignIn) {
    return <>
      <button type="button" disabled={busy || signIn.isPending} className={actionClass({ variant: "primary", size: "sm" })}
        onClick={() => signIn.mutate()}>
        {signIn.isPending ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
        {" "}Sign in to {setting.scope}
      </button>
      <p className="basis-full text-[12px] text-muted-foreground">You sign in on {setting.scope}&apos;s own page; your password never reaches xMatrix.</p>
      {error ? <p role="alert" className="basis-full text-[13px] font-medium text-destructive">{error}</p> : null}
    </>;
  }
  return <>
    <CredentialValueForm field={{ id: setting.address, label: setting.label }} busy={busy} saving={busy} submitLabel="Save and check"
      variant="primary" className="flex min-w-0 flex-1 flex-wrap items-center gap-2" save={(value) => make(setting.address, value)} />
    <p className="basis-full text-[12px] text-muted-foreground">
      Sign in from the xMatrix app, or paste the Cookie header of a signed-in {setting.scope} page.
    </p>
  </>;
}

/** Who a setting waits on, for a viewer who cannot make it. */
const WAITS_ON: Record<SettingWriter, string> = {
  "space-admin": "A Space admin can make this.",
  "machine-owner": "The Machine's owner signs in on it.",
};

/** Where a setting stands, in the words of its control. */
function stateWord(setting: CardSetting): string {
  if (setting.satisfied) return setting.value ?? (setting.control === "grant" ? "Allowed" : "Done");
  if (setting.state === "invalid") return "Refused";
  if (setting.state === "verified" || setting.state === "set") return "Asked again";
  return setting.control === "sign-in" || setting.control === "harness-sign-in" ? "Not signed in"
    : setting.control === "connect" ? "Not connected" : setting.control === "grant" ? "Not allowed" : "Missing";
}

/** The card's heading: one setting by what it asks, several by count. */
function heading(settings: readonly CardSetting[], satisfied: boolean): string {
  const [only] = settings;
  if (settings.length !== 1 || !only) return satisfied ? "All set" : `${settings.length} settings needed`;
  if (satisfied) return only.control === "sign-in" || only.control === "connect" ? `${only.scope} is ready` : `${only.label}: done`;
  return only.control === "sign-in" ? `Sign in to ${only.scope}` : only.control === "connect" ? `Connect ${only.scope} again`
    : only.control === "harness-sign-in" ? only.scope : only.control === "grant" ? only.label : `${only.scope} needs ${only.label}`;
}

/**
 * A settings card: the settings a stopped command or an Agent needs, as the
 * Hub reads them for this viewer, each with the control that makes it. A
 * value goes straight to where the setting lives through the Hub; the
 * conversation only ever shows the outcome. When every setting is in, a
 * stopped read runs again, and an Agent's card is answered, which wakes it.
 */
export function SettingsCard({ channelId, messageId, sequence, token, userId, agentName, reason }: {
  channelId: string;
  messageId: string;
  sequence: number;
  token: string;
  userId: string;
  /** The Agent that asked, from the Hub's own card. */
  agentName?: string;
  reason?: string;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "settings-card", [channelId, messageId]);
  const card = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<CardView>({ token, signal,
      url: `${WEB_PROXY_ROUTES.channel_settings_card(channelId, messageId)}?sequence=${sequence}` }),
    refetchInterval: (query) => query.state.data?.satisfied ? false : OPEN_REFRESH_MS,
  });
  const rerun = useMutation({
    mutationKey: ["settings-card-rerun", messageId],
    mutationFn: ({ spaceId, executionId }: { spaceId: string; executionId: string }) =>
      xmatrixApiRequest<{ summary: string }>({ method: "POST", token, url: WEB_PROXY_ROUTES.space_app_execution_retry(spaceId, executionId) }),
  });
  const make = useMutation({
    mutationKey: ["settings-card-make", messageId],
    mutationFn: ({ address, value }: { address: string; value: string }) => xmatrixApiRequest<CardView>({ method: "PUT", token,
      url: WEB_PROXY_ROUTES.channel_settings_card(channelId, messageId), body: { sequence, address, value } }),
    onSuccess: (view) => {
      queryClient.setQueryData(key, view);
      // A stopped read runs again once what it needed is in; an Agent's card is answered by the Hub.
      if (view.satisfied && view.resumeExecutionId) rerun.mutate({ spaceId: view.spaceId, executionId: view.resumeExecutionId });
    },
  });
  const view = card.data;
  if (!view) {
    return card.isError ? (
      <p role="alert" className="mt-2 text-[13px] text-muted-foreground">
        {userErrorMessage(card.error, "Couldn't read the settings on this card")}
      </p>
    ) : null;
  }
  const asked = agentName ?? view.askedBy;
  const error = userErrorMessage(make.error, "Couldn't save the setting");
  const makeOne: Make = (address, value) => make.mutateAsync({ address, value });
  return (
    <section className="app-paper-card app-settings-card mt-2 w-full max-w-2xl" data-settings-card={view.satisfied ? "settled" : "open"}
      aria-label={heading(view.settings, view.satisfied)}>
      {asked !== undefined ? (
        <div data-settings-request="">
          <p className="text-[14px]"><strong>{asked || "An Agent"}</strong> asks for
            {view.settings.length === 1 ? " this setting" : " these settings"}{reason ? ":" : "."}</p>
          {reason ? <p className="mt-1 border-l-2 border-border pl-2.5 text-[13.5px] text-muted-foreground">{reason}</p> : null}
        </div>
      ) : null}
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-semibold">{heading(view.settings, view.satisfied)}</p>
        <span className="text-[12px] text-muted-foreground">Settings</span>
      </div>
      {view.settings.map((setting) => {
        const Control = CONTROLS[setting.control];
        return (
          <div key={setting.address} className="app-settings-card-row mt-2" data-setting={setting.address}>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium">{setting.label}</p>
                <p className="truncate font-mono text-[11.5px] text-muted-foreground">{setting.address}</p>
              </div>
              <span className="app-settings-card-state inline-flex items-center gap-1.5 text-[12.5px] font-semibold"
                data-settled={setting.satisfied ? "true" : "false"} role="status">
                <span aria-hidden="true" className="app-settings-card-dot" />{make.isPending && make.variables?.address === setting.address
                  ? "Checking…" : stateWord(setting)}
              </span>
            </div>
            {!setting.satisfied && setting.canWrite && Control ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Control setting={setting} busy={make.isPending} make={makeOne} refresh={() => void card.refetch()}
                  suggestedBy={asked} token={token} userId={userId} />
              </div>
            ) : null}
            {!setting.satisfied && !setting.canWrite ? (
              <p className="mt-2 text-[13px] text-muted-foreground">{WAITS_ON[setting.writer]}</p>
            ) : null}
            {!setting.satisfied && setting.problem ? (
              <p role="alert" className="mt-2 text-[13px] font-medium text-destructive">{setting.problem}</p>
            ) : null}
          </div>
        );
      })}
      {view.satisfied && rerun.data ? <p className="mt-2 text-[13px] text-muted-foreground">Ran it again: {rerun.data.summary}</p> : null}
      {error ? <p role="alert" className="mt-2 text-[13px] font-medium text-destructive">{error}</p> : null}
    </section>
  );
}
