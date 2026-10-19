# Authoring release notes

The stable release Agent writes `docs/releases/<version>.md` before choosing
the final beta candidate. Start with `# xMatrix <version>`, followed by concise,
user-facing Markdown covering features, improvements, fixes, compatibility or
upgrade actions, and known limitations since the previous stable. Omit empty
sections. Describe verified behavior; do not substitute deployment logs or a
list of PR titles for the summary. Keep the document within 32 KiB.

Merge the notes through a PR, request a beta containing them, verify that beta,
then request stable with the intended bump. Both the intent and the train read
the exact target version's notes from the candidate's source tree; notes added
only to newer main cannot authorize an older beta. If the chosen bump changes,
update the filename and heading and verify a new candidate.

The successful release receipt publishes this text to the immutable GitHub
Release. Beta releases use GitHub's generated change list for their exact tag.
The Web page `/releases/<version>` reads that published Release and presents
only the user-facing notes. Deployment evidence remains on GitHub. Update
manifests, Desktop settings and dialogs, Machine version rows, and CLI update
output link to that exact version. Older releases without notes explicitly say
they are unavailable. A GitHub outage offers retry instead of showing a different
version's notes. Before the final receipt exists, stable pages can already read
the authored document from that exact immutable tag. Beta notes become available
with the receipt. Verify the notes after the entire release succeeds.

After publication, verify the GitHub Release, the exact public page, and the
update entry point before reporting completion. Recover receipt failures by
re-running the same release's failed jobs; never modify an immutable tag or
replace a published release's notes in place.
