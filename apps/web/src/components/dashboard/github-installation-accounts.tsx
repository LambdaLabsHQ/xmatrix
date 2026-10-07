"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { GitPullRequest, Link2, Plus, Unlink } from "lucide-react";
import { COUNT_CHIP_MATERIAL_CLASS } from "@/components/dashboard/workspace-shell-constants";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { cn } from "@/lib/utils";

type GitHubInstallationAccount = {
  installationId: string;
  login: string;
  type: string;
  avatarUrl?: string;
  repositorySelection?: string;
};

type GitHubInstallations = {
  linked: GitHubInstallationAccount[];
  available: GitHubInstallationAccount[];
  accountRequired: boolean;
};

const ACTION_CLASS = cn(
  "app-connector-secondary-action inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-bold disabled:opacity-50",
  COUNT_CHIP_MATERIAL_CLASS,
);

/**
 * The GitHub accounts and organizations this Space reaches, one App
 * installation each. Installations the admin's GitHub account already has are
 * linked here directly, since GitHub does not return to xMatrix for an account
 * whose installation is unchanged.
 */
export function GitHubInstallationAccounts({ spaceId, token, onManage, onInstall, onChanged }: {
  spaceId: string;
  token: string;
  onManage: (installationId: string) => void;
  onInstall: () => void;
  onChanged: () => Promise<void>;
}) {
  const [installations, setInstallations] = useState<GitHubInstallations | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = WEB_PROXY_ROUTES.space_app_connection_github_installations(spaceId);

  const load = useCallback(async () => {
    try {
      const payload = await xmatrixApiRequest<Partial<GitHubInstallations>>({ url, token });
      setInstallations({
        linked: Array.isArray(payload?.linked) ? payload.linked : [],
        available: Array.isArray(payload?.available) ? payload.available : [],
        accountRequired: payload?.accountRequired === true,
      });
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [url, token]);

  useEffect(() => { void load(); }, [load]);

  async function change(installationId: string, request: () => Promise<unknown>) {
    setBusyId(installationId);
    setError(null);
    try {
      await request();
      await Promise.all([load(), onChanged()]);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const link = (installationId: string) => change(installationId, () =>
    xmatrixApiRequest({ url, token, method: "POST", body: { installationId } }));
  const unlink = (installationId: string) => change(installationId, () =>
    xmatrixApiRequest({
      url: WEB_PROXY_ROUTES.space_app_connection_github_installation(spaceId, installationId),
      token,
      method: "DELETE",
    }));

  return (
    <div className="app-connector-provider-access" data-testid="github-installation-accounts">
      <p className="text-xs leading-5 text-muted-foreground">
        Each GitHub account or organization is its own App installation. This Space reaches the
        repositories of every account linked here.
      </p>
      {!installations && !error ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading GitHub accounts…</p>
      ) : null}
      {installations ? (
        <ul className="mt-3 space-y-2">
          {installations.linked.map((account) => (
            <AccountRow key={account.installationId} account={account}>
              <button type="button" className={ACTION_CLASS} onClick={() => onManage(account.installationId)}>
                <GitPullRequest className="size-3.5" /> Manage on GitHub
              </button>
              <button type="button" className={ACTION_CLASS} disabled={busyId !== null}
                aria-label={`Unlink ${account.login}`} onClick={() => void unlink(account.installationId)}>
                <Unlink className="size-3.5" /> {busyId === account.installationId ? "Unlinking" : "Unlink"}
              </button>
            </AccountRow>
          ))}
          {installations.linked.length === 0 ? (
            <li className="text-xs text-muted-foreground">No GitHub account is linked to this Space.</li>
          ) : null}
        </ul>
      ) : null}
      {installations && installations.available.length > 0 ? (
        <>
          <p className="mt-4 text-xs font-bold uppercase text-muted-foreground">Installed on GitHub, not linked here</p>
          <ul className="mt-2 space-y-2">
            {installations.available.map((account) => (
              <AccountRow key={account.installationId} account={account}>
                <button type="button" className={ACTION_CLASS} disabled={busyId !== null}
                  aria-label={`Link ${account.login}`} onClick={() => void link(account.installationId)}>
                  <Link2 className="size-3.5" /> {busyId === account.installationId ? "Linking" : "Link"}
                </button>
              </AccountRow>
            ))}
          </ul>
        </>
      ) : null}
      {installations?.accountRequired ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Link your GitHub account in your profile to see the accounts where the App is already installed.
        </p>
      ) : null}
      {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
      <div className="mt-3">
        <button type="button" className={ACTION_CLASS} onClick={onInstall}>
          <Plus className="size-3.5" /> Install on another account
        </button>
      </div>
    </div>
  );
}

function AccountRow({ account, children }: { account: GitHubInstallationAccount; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="github-installation-account">
      {account.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- GitHub avatars are remote and tiny.
        <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-6 rounded-full" />
      ) : null}
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-bold">{account.login}</span>
        <span className="ml-1.5 text-xs text-muted-foreground">
          {account.type === "Organization" ? "Organization" : account.type === "User" ? "Personal account" : account.type}
          {account.repositorySelection === "all" ? " · all repositories" : account.repositorySelection === "selected" ? " · selected repositories" : ""}
        </span>
      </span>
      <span className="flex gap-2">{children}</span>
    </li>
  );
}
