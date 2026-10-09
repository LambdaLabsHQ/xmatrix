# Password access for verified accounts

Email OTP and Google remain the registration methods. Password sign-up is disabled.
An existing account may request a password link from `/reset-password`. The link is
sent through the existing Cloudflare Email Sending service, expires after ten minutes,
and is consumed once. Password sign-in requires a verified email, uses Better Auth's
password hashing and session authority, and is limited to five attempts per minute per
client IP within a Worker, in addition to the Hub request limiter.

`/login/password` returns through the existing login screen after sign-in so native
and device authorization keep their normal validation. Reset pages use no-referrer
metadata. Passwords and reset tokens must never be logged or put in public source,
release artifacts, or channel messages. Mail delivery failures are re-raised even if
the authentication library returns a nominal successful response.

For App Review, create a separate account through normal verified registration, set
its password using the normal reset flow, and give it only a dedicated sample Space.
Do not reuse an owner's account, mailbox password, or customer workspace. Put reviewer
credentials only in the approved Secret stores and Apple's private review fields.
Test the credential independently before claiming review access is ready. Account
deletion removes the credential account and prevents subsequent password sign-in.
