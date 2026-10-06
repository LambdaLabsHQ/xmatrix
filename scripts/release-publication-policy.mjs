const transactionMarkerPattern = /<!-- xmatrix-release-transaction:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) -->/;
const transactionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const immutableVersionTagPattern = /^(?:cli|desktop|android|xmatrix)-v\S+$/;

export function isImmutableVersionTag(tag) {
  return immutableVersionTagPattern.test(tag ?? "");
}

export function assertReleaseTransactionId(transactionId) {
  if (!transactionIdPattern.test(transactionId ?? "")) {
    throw new Error(
      "RELEASE_TRANSACTION_ID must identify one GitHub run attempt using 1-128 letters, digits, '.', '_', ':', or '-'.",
    );
  }
}

export function releaseNotesWithTransaction(notes, transactionId) {
  assertReleaseTransactionId(transactionId);
  if (transactionMarkerPattern.test(notes)) {
    throw new Error("RELEASE_NOTES must not contain an xMatrix release transaction marker.");
  }
  return `${notes.trimEnd()}\n\n<!-- xmatrix-release-transaction:${transactionId} -->`;
}

export function assertImmutableReleaseTransaction({ release, tag, transactionId }) {
  assertReleaseTransactionId(transactionId);
  if (!release) return;

  if (!release.draft) {
    throw new Error(
      `Release ${tag} is already published and immutable. Bump version.json before publishing again.`,
    );
  }

  // Unpublished drafts may be resumed or claimed by a later run attempt. Only a
  // published release consumes the product version permanently.
}

export function assertImmutableTagCanBeUsed({ release, tag, tagExists, transactionId }) {
  assertReleaseTransactionId(transactionId);
  if (!tagExists) return;

  if (release && !release.draft) {
    throw new Error(
      `Tag ${tag} already points at a published release and is immutable. ` +
        "Bump version.json before publishing again.",
    );
  }

  // Draft releases and orphan tags (tag without a published release) remain
  // reclaimable so a failed upload or pre-publish crash can retry the same version.
}

export function assertAnnotatedTagTargetsCommit({ tag, expectedSha, tagObject }) {
  if (!/^[0-9a-f]{40}$/iu.test(expectedSha ?? "")) {
    throw new Error(`Expected commit for annotated tag ${tag} must be one full Git SHA.`);
  }
  const targetType = tagObject?.object?.type;
  const targetSha = tagObject?.object?.sha;
  if (targetType !== "commit" || !/^[0-9a-f]{40}$/iu.test(targetSha ?? "")) {
    throw new Error(`Annotated tag ${tag} must directly target one Git commit.`);
  }
  if (targetSha !== expectedSha) {
    throw new Error(
      `Annotated tag ${tag} targets ${targetSha}; expected immutable commit ${expectedSha}.`,
    );
  }
  return targetSha;
}
