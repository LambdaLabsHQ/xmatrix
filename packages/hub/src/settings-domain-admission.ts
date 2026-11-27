import { PostgresPageRepository, type SpaceAdmissionPolicy } from "@xmatrix/db";
import { appViewAddress, sha256Hex, type ParsedSettingAddress, type SettingDescriptor } from "@xmatrix/protocol";
import { admissionPolicyProblems } from "./admission-policy";
import { spaceSecretRepository } from "./index-routes-secrets";
import { nornLibBlocks } from "./norn-host";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { SettingWriteRefused, type SettingDomainResolver, type SettingsReader } from "./settings-registry";

/** Where the admission domain reads and writes, replaceable in tests. */
export interface AdmissionSettingsPort {
  /** The Space's adopted policy and whether this reader may adopt one; its text only for a reader who may. */
  adopted(reader: SettingsReader): Promise<{ policy?: SpaceAdmissionPolicy; canAdopt: boolean }>;
  /** A Page of the reader's Space as the reader may read it, or undefined. */
  page(reader: SettingsReader, pageId: string): Promise<{ title: string; body: string } | undefined>;
  adopt(reader: SettingsReader, input: { pageId: string; libraryName: string; sourceText: string; sourceSha256: string }): Promise<void>;
  withdraw(reader: SettingsReader): Promise<void>;
}

const PORT: AdmissionSettingsPort = {
  async adopted(reader) {
    try { return await spaceSecretRepository(reader.env).admissionPolicy({ spaceId: reader.spaceId, userId: reader.userId }); }
    // A reader outside the Space's members sees that a policy is asked for, not what is adopted.
    catch { return { canAdopt: false }; }
  },
  async page(reader, pageId) {
    const database = createPostgresAuthorityDatabase(reader.env, { applicationName: "xmatrix-pages",
      statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 });
    try {
      // The read is scoped to the reader's Space: a Page of another Space names nothing here.
      const { page } = await new PostgresPageRepository(database).read({ requestId: crypto.randomUUID(), spaceId: reader.spaceId,
        pageId, principal: { kind: "user", id: reader.userId } });
      return { title: page.title, body: page.body };
    } catch { return undefined; }
  },
  async adopt(reader, input) {
    await spaceSecretRepository(reader.env).adoptAdmissionPolicy({ spaceId: reader.spaceId, userId: reader.userId, ...input });
  },
  async withdraw(reader) {
    await spaceSecretRepository(reader.env).withdrawAdmissionPolicy({ spaceId: reader.spaceId, userId: reader.userId });
  },
};

interface Standing {
  pageId: string; libraryName: string; title?: string; sourceText?: string; sourceSha256?: string;
  /** What keeps it from being adopted. */
  problem?: string;
}

/** A library's text as it stands on a Page now, with what keeps it from being adopted. */
async function standing(port: AdmissionSettingsPort, reader: SettingsReader, address: ParsedSettingAddress): Promise<Standing> {
  const [pageId, libraryName] = address.parts as [string, string];
  const page = await port.page(reader, pageId);
  if (!page) return { pageId, libraryName, problem: "That Page is not in this Space, or you cannot read it" };
  const block = nornLibBlocks(page.body).find((candidate) => candidate.name === libraryName);
  if (!block) return { pageId, libraryName, title: page.title, problem: `The Page has no \`norn 1 lib ${libraryName}\` block` };
  if (block.problem) return { pageId, libraryName, title: page.title, problem: block.problem };
  const problems = admissionPolicyProblems(block.source);
  return { pageId, libraryName, title: page.title, sourceText: block.source, sourceSha256: await sha256Hex(block.source),
    ...(problems.length ? { problem: problems.slice(0, 5).map((found) => `${found.line}:${found.column} ${found.message}`).join("\n") } : {}) };
}

/**
 * `admission:<page id>/<library>`: the Space's admission policy
 * (docs/design/admission-policy.md), adopted from the text of one library on
 * one of the Space's Pages. Only a Space owner or admin adopts, in person;
 * an Agent that edits the Page has proposed a text. The address names the
 * Page, so a library of the same name elsewhere neither stands in for it nor
 * blocks it. It is in once the adopted text is the Page's: a text adopted
 * before the card asked satisfies it, as an open secret satisfies
 * `secret-access`.
 */
export function admissionSettingsDomain(port: AdmissionSettingsPort = PORT): SettingDomainResolver {
  return {
    async describe(reader, addresses) {
      const { policy, canAdopt } = await port.adopted(reader);
      const described: SettingDescriptor[] = [];
      for (const address of addresses) {
        const text = await standing(port, reader, address);
        const adoptedHere = policy?.pageId === text.pageId && policy.libraryName === text.libraryName;
        const current = Boolean(adoptedHere && text.sourceSha256 && policy!.sourceSha256 === text.sourceSha256);
        described.push({
          address: address.address, domain: "admission", scope: "Space secrets",
          label: `Admission policy ${text.libraryName}${text.title ? ` on ${text.title}` : ""}`,
          description: "Decides which Agent Runs use a secret that asks first without a card. " +
            "Where it answers AlsoAsk, the request gets its card, as without a policy, whoever is named.",
          control: "adopt", sensitivity: "plain", writer: "space-admin",
          state: text.problem ? "invalid" : adoptedHere ? "set" : "missing",
          satisfied: current && !text.problem,
          canWrite: canAdopt && !text.problem && Boolean(text.sourceText),
          // The text is given only to a reader who may adopt it.
          ...(canAdopt && text.sourceText ? { value: text.sourceText } : {}),
          href: appViewAddress(reader.spaceId, "settings", "secrets"),
          ...(text.problem ? { problem: text.problem } : {}),
        });
      }
      return described;
    },
    async write(reader, address, value) {
      if (value === null) { await port.withdraw(reader); return; }
      const text = await standing(port, reader, address);
      if (text.problem || !text.sourceText || !text.sourceSha256) {
        throw new SettingWriteRefused(text.problem ?? "That library cannot be adopted");
      }
      // The answer is the text the person was shown: one that changed on the Page since is not adopted.
      if (value !== text.sourceText) {
        throw new SettingWriteRefused("The library changed on its Page since it was shown; read it again before adopting", 409);
      }
      await port.adopt(reader, { pageId: text.pageId, libraryName: text.libraryName, sourceText: text.sourceText,
        sourceSha256: text.sourceSha256 });
    },
  };
}
