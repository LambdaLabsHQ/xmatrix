"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { Link2 } from "lucide-react";
import { SearchGlyph } from "@/components/ui/search-glyph";
import { Face } from "./face";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { readGitHubGrant } from "@/lib/github-connect-return";
import { userErrorMessage } from "@/lib/user-facing-error";
import { ConnectorAction, ConnectorAddRow, ConnectorEmpty, ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";

type GitHubInstallationAccount = {
  installationId: string;
  login: string;
  type: string;
  avatarUrl?: string;
  repositorySelection?: string;
  /** A linked account is used only once an administrator of it confirmed it by connecting. */
  confirmed?: boolean;
};

type GitHubInstallations = {
  linked: GitHubInstallationAccount[];
  available: GitHubInstallationAccount[];
  authorized: boolean;
};

/**
 * The GitHub accounts and organizations this Space reaches, one App
 * installation each. Connecting authorizes on GitHub, which confirms the
 * installations this person administers; they are linked here directly, since
 * GitHub does not return to xMatrix for an installation that is unchanged.
 */
export function GitHubInstallationAccounts({ spaceId, token, hideWhenEmpty = false, onManage, onAuthorize, onInstall, onChanged }: {
  spaceId: string;
  token: string;
  /** Say nothing until there is an account to show (the page offers Connect instead). */
  hideWhenEmpty?: boolean;
  onManage: (installationId: string) => void;
  onAuthorize: () => void;
  onInstall: () => void;
  onChanged: () => Promise<void>;
}) {
  const [grant, setGrant] = useState<string | undefined>(undefined);
  const [installations, setInstallations] = useState<GitHubInstallations | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = WEB_PROXY_ROUTES.space_app_connection_github_installations(spaceId);

  const load = useCallback(async (currentGrant: string | undefined) => {
    try {
      const query = currentGrant ? `?grant=${encodeURIComponent(currentGrant)}` : "";
      const payload = await xmatrixApiRequest<Partial<GitHubInstallations>>({ url: `${url}${query}`, token });
      setInstallations({
        linked: Array.isArray(payload?.linked) ? payload.linked : [],
        available: Array.isArray(payload?.available) ? payload.available : [],
        authorized: payload?.authorized === true,
      });
    } catch (caught) {
      setError(userErrorMessage(caught, "Couldn't load GitHub accounts"));
    }
  }, [url, token]);

  useEffect(() => {
    const current = readGitHubGrant();
    setGrant(current);
    void load(current);
  }, [load]);

  async function change(installationId: string, request: () => Promise<unknown>) {
    setBusyId(installationId);
    setError(null);
    try {
      await request();
      await Promise.all([load(grant), onChanged()]);
    } catch (caught) {
      setError(userErrorMessage(caught, "Couldn't change the GitHub account"));
    } finally {
      setBusyId(null);
    }
  }

  const link = (installationId: string) => change(installationId, () =>
    xmatrixApiRequest({ url, token, method: "POST", body: { installationId, grant } }));
  const unlink = (installationId: string) => change(installationId, () =>
    xmatrixApiRequest({
      url: WEB_PROXY_ROUTES.space_app_connection_github_installation(spaceId, installationId),
      token,
      method: "DELETE",
    }));

  // Before the Space is connected the page's own sheet offers Connect; this part
  // speaks only once it has accounts to show.
  if (hideWhenEmpty && (!installations || (installations.linked.length === 0 && installations.available.length === 0))) {
    return error ? <p className="text-[13px] text-destructive" role="alert">{error}</p> : null;
  }
  return (
    <ConnectorSection title="GitHub accounts" testId="github-installation-accounts"
      note="Each account or organization is its own App installation. This Space reaches the repositories of every account linked here."
      action={installations && !installations.authorized ? (
        <ConnectorAction onClick={onAuthorize}><SearchGlyph className="size-3.5" /> Find my GitHub accounts</ConnectorAction>
      ) : null}>
      {!installations && !error ? <p className="py-2.5 text-[13px] text-muted-foreground">Loading GitHub accounts…</p> : null}
      {installations ? (
        <ConnectorRows>
          {installations.linked.map((account) => (
            <AccountRow key={account.installationId} account={account}>
              <ConnectorAction onClick={() => onManage(account.installationId)}>Manage on GitHub</ConnectorAction>
              <ConnectorAction disabled={busyId !== null} aria-label={`Unlink ${account.login}`}
                onClick={() => void unlink(account.installationId)}>
                {busyId === account.installationId ? "Unlinking" : "Unlink"}
              </ConnectorAction>
            </AccountRow>
          ))}
          {installations.linked.length === 0 ? <ConnectorEmpty>No GitHub account is linked to this Space.</ConnectorEmpty> : null}
          <ConnectorAddRow label="Install on another account" onClick={onInstall} />
        </ConnectorRows>
      ) : null}
      {installations && installations.available.length > 0 ? (
        <>
          <p className="mt-4 text-[13px] font-semibold">Your GitHub accounts, not linked here</p>
          <ConnectorRows>
            {installations.available.map((account) => (
              <AccountRow key={account.installationId} account={account}>
                <ConnectorAction disabled={busyId !== null} aria-label={`Link ${account.login}`}
                  onClick={() => void link(account.installationId)}>
                  <Link2 className="size-3.5" /> {busyId === account.installationId ? "Linking" : "Link"}
                </ConnectorAction>
              </AccountRow>
            ))}
          </ConnectorRows>
        </>
      ) : null}
      {installations?.authorized && installations.available.length === 0 ? (
        <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.45] text-muted-foreground">
          Every account you administer with the App installed is already linked. An organization
          you do not own is linked by one of its owners.
        </p>
      ) : null}
      {error ? <p className="mt-1 text-[13px] text-destructive" role="alert">{error}</p> : null}
    </ConnectorSection>
  );
}

function AccountRow({ account, children }: { account: GitHubInstallationAccount; children: ReactNode }) {
  return (
    <ConnectorRow testId="github-installation-account"
      // A GitHub account has no xMatrix account: its face is the picture GitHub gives.
      leading={<Face of={{ kind: "external", name: account.login, imageUrl: account.avatarUrl ?? null }} size="xs" shape="circle"
        glass={false} className="size-7 [&_.identity-avatar-face]:size-7" />}
      title={account.login}
      meta={<>
        {account.type === "Organization" ? "Organization" : account.type === "User" ? "Personal account" : account.type}
        {account.repositorySelection === "all" ? " · all repositories" : account.repositorySelection === "selected" ? " · selected repositories" : ""}
        {account.confirmed === false ? (
          <span className="block" data-testid="github-installation-unconfirmed">
            Paused until its owner, or an owner of the organization, uses Find my GitHub accounts here.
          </span>
        ) : null}
      </>}
      trailing={children} />
  );
}
