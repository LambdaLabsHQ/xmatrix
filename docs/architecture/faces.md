# Faces

Every face the product draws, a person's or an Agent's, goes through one interface. A person shows the same
picture everywhere and the moment they change it, and an Agent shows its vendor's mark whatever alias its harness
was written with.

## One rule per kind

| Whose | Face | Where it is resolved |
|---|---|---|
| A person (`user`) | Their account's picture, `control.auth_users.image`, or none. | Hub, read by user id |
| An Agent by harness | Its harness's vendor mark, aliases resolved (`claude_code` → claude); none for a custom harness. | `agentFaceUrl`, no read |
| An Agent known only by its Instance | The mark of the harness its Run was registered with. | Hub, read by Instance id in the Space |
| An imported author (`external`, id `<source>:<id>`) | The picture their source gave; there is no other. | the message |
| An App, a Machine, xMatrix | The App's mark, a Machine's icon, xMatrix's mark. | no read |

Copies of a person's picture are never read for their face: the per-Space member row (`space_members.avatar_url`,
copied at join time and stale for most members), the session token's `avatarUrl` (up to an hour old), presence,
and the sender snapshot a message stores. Messages still store their sender snapshot as part of the immutable
record (relay storage); the Web draws the sender's current face, not the snapshot's picture. A name such as
`claude:1` is never parsed for a harness.

Letters (`faceInitials`) stand in only for a face that has no picture.

## Interface

- `packages/protocol/src/faces.ts`: `FaceOf` (whose face), `agentFaceUrl`, `faceInitials`, `staticFace` (the faces
  that need no read), `faceOfSender` (a message's sender as a face), and the read contract `FacesRead`.
- `GET /api/spaces/:spaceId/faces?user=<userId>&agent=<instanceId>…`: up to 100 ids per read, for a member of the
  Space. People are read from the Auth authority; Instances from the Space's shard (`packages/db/src/faces.ts`).
- Web: `<Face of={…} />` and `useFace(of)` (`apps/web/src/components/dashboard/face.tsx`) are the only way a person
  or an Agent is drawn. Chips that draw their own markup use `useFace` for the picture and the letters.

## Caching

- **Mapping** (`apps/web/src/lib/faces/face-directory.ts`): id → picture. The faces one render asks for are read in
  one request per Space. What was read is kept in the tab and in local storage, so a reload draws every face at
  once. A face read more than ten minutes ago is drawn as kept and read again when next drawn; a failed read is
  tried again after thirty seconds. A face whose picture is still being read waits for it rather than flashing
  letters. A reader's own new picture is written to the directory as they set it.
- **Pictures**, below the mapping: a stored picture's URL names its bytes (`/api/avatars/<user>/<sha256>.<ext>`) and
  is cached for a year, immutable; a Google picture goes through `/api/xmatrix/avatar`, cached a day; vendor marks
  are static assets; a face the tab has drawn stays decoded (`LoadingImage` `retain`).
