# A new account's first Space

A person who opens xMatrix with no Space at all lands in one of their own,
named after them ("Ada Lovelace's Space", or the email's name part when the
account has no name). Without it the first screen is an app with no Space, in
which nothing can be done and nothing says how to start.

- `POST /api/personal-space` (Web: `/api/xmatrix/personal-space`) creates it.
  The Web shell calls it only when the Space list it loads is empty.
- The Hub creates it only for a Human session whose account has no Space at
  the moment of the call. Agent Runs are refused by the Run route allowlist.
  Anyone who already has a Space, including someone who arrived through an
  invite or join link, gets `{ "space": null }` and nothing is created.
- The Space id derives from the account id and the command id is fixed per
  account, so a retry or a second tab replays the same `create-space` command.
  Once the personal Space exists, deleting it does not bring it back: the next
  call conflicts on the id and returns `{ "space": null }`.
- It is an ordinary Space with the caller as its owner. It can be renamed,
  shared and deleted like any other.
