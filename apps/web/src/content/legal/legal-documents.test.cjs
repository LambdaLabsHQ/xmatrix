const assert = require("node:assert/strict");
const test = require("node:test");

const { webSourceTree } = require("../../components/dashboard/source-scan-fixture.cjs");
const read = webSourceTree().readRelative;

const privacySource = read("content/legal/privacy-policy.tsx");
const termsSource = read("content/legal/terms-of-service.tsx");
const cookiesSource = read("content/legal/cookie-notice.tsx");
const subprocessorsSource = read("content/legal/subprocessors.tsx");
const legalDocumentSource = read("components/legal/legal-document.tsx");
const privacyPageSource = read("app/privacy/page.tsx");
const termsPageSource = read("app/terms/page.tsx");
const cookiesPageSource = read("app/cookies/page.tsx");
const subprocessorsPageSource = read("app/subprocessors/page.tsx");
const footerSource = read("components/landing/footer.tsx");
const loginSource = read("app/login/page.tsx");
const settingsSource = read("components/dashboard/workspace-admin-views.tsx");

test("legal pages render repository-owned policy sources", () => {
  const pages = [
    [privacyPageSource, "PrivacyPolicyContent"],
    [termsPageSource, "TermsOfServiceContent"],
    [cookiesPageSource, "CookieNoticeContent"],
    [subprocessorsPageSource, "SubprocessorsContent"],
  ];

  for (const [source, component] of pages) {
    assert.match(source, new RegExp(`import \\{ ${component} \\}`));
    assert.match(source, new RegExp(`<${component} \\/>`));
  }
  assert.doesNotMatch(privacyPageSource, /Information we collect/);
  assert.doesNotMatch(termsPageSource, /Management Agent authority/);
});

test("published drafts identify the confirmed operator, contact, status, and language", () => {
  assert.match(legalDocumentSource, /MadeByRobot, LLC/);
  assert.match(legalDocumentSource, /contact@madebyrobot\.net/);
  assert.match(legalDocumentSource, /Pre-launch draft 2026-09-14/);
  assert.match(legalDocumentSource, /Formal public launch date/);
  assert.doesNotMatch(legalDocumentSource, /August 10, 2026|hello@madebyrobot\.net/);
  assert.match(privacySource, /English is the controlling version/);
  assert.match(termsSource, /English is the controlling version/);
});

test("privacy policy locks the actual Agent, trace, secret, and training boundaries", () => {
  assert.match(
    privacySource,
    /MadeByRobot does not use Customer Data[\s\S]*to train a\s+MadeByRobot/,
  );
  assert.doesNotMatch(privacySource, /unless we first obtain explicit permission/);
  assert.doesNotMatch(privacySource, /Management Agent/);
  assert.match(privacySource, /separate one-shot approval/);
  assert.match(privacySource, /at most 500 events, 768 KiB, or 24 hours/);
  assert.match(privacySource, /does not currently keep a Relay authority, R2, or other persistent copy/);
  assert.match(privacySource, /does not automatically gain trace\s+access/);
  assert.match(privacySource, /Secret values are not ordinary message or Profile\s+fields/);
  assert.match(privacySource, /current local sandbox support[\s\S]*does not enforce network egress/);
});

test("privacy policy does not claim unimplemented regional transfer mechanisms", () => {
  assert.match(privacySource, /Before a transfer requires a regional transfer mechanism/);
  assert.match(privacySource, /These may include Standard\s+Contractual Clauses or a UK Addendum/);
  assert.doesNotMatch(privacySource, /Where required, we use a legally recognized transfer mechanism/);
});

test("privacy policy separates MadeByRobot providers from Customer-selected providers", () => {
  assert.match(privacySource, /Cloudflare/);
  assert.match(privacySource, /Anthropic/);
  assert.match(privacySource, /Google or Stripe/);
  assert.match(privacySource, /Customer-selected provider/);
  assert.match(privacySource, /enterprise or API no-training setting/);
  assert.match(privacySource, /do not sell personal information/);
  assert.match(subprocessorsSource, /Cloudflare, Inc\./);
  assert.match(subprocessorsSource, /Anthropic, PBC/);
  assert.match(subprocessorsSource, /Customer-selected providers/);
  assert.match(subprocessorsSource, /Initial public release/);
});

test("terms preserve Customer ownership and the narrow service license", () => {
  assert.match(termsSource, /Customer owns and controls Customer Data\.\s+MadeByRobot/);
  assert.match(termsSource, /MadeByRobot\s+does not acquire ownership of Customer Data/);
  assert.match(termsSource, /only as reasonably necessary to provide,\s+maintain/);
  assert.match(termsSource, /does not authorize a general “improve the Services” use/);
  assert.match(termsSource, /does not use Customer Data to train a\s+MadeByRobot\s+model/);
  assert.doesNotMatch(termsSource, /unrestricted, unlimited, irrevocable, perpetual[\s\S]*Customer Data/);
});

test("terms lock confirmed Agent authority, risk review, and provider responsibility", () => {
  assert.match(termsSource, /Customer-operated Agent/);
  assert.match(termsSource, /Service Agent/);
  assert.match(termsSource, /MadeByRobot remains responsible for the Services/);
  assert.doesNotMatch(termsSource, /Management Agent/);
  assert.match(termsSource, /separate one-shot human approval/);
  assert.match(termsSource, /does\s+not enforce network egress/);
  assert.match(termsSource, /MadeByRobot\s+does not claim\s+ownership of output/);
  assert.match(termsSource, /risk-proportionate human review/);
});

test("terms lock billing, liability, indemnity, and dispute decisions", () => {
  assert.match(termsSource, /whether monthly or annual, automatically renews/);
  assert.match(termsSource, /charged in advance for twelve months and renews\s+for another twelve months/);
  assert.match(termsSource, /reminder to the billing email\s+address at least 30 days before the renewal charge/);
  assert.match(termsSource, /Cancellation takes effect at the end of the current paid period/);
  assert.match(termsSource, /unused remainder of a monthly\s+or annual period is not refunded/);
  assert.match(termsSource, /Prices exclude taxes/);
  assert.match(termsSource, /calculated at checkout and on each renewal/);
  assert.match(termsSource, /seven-day\s+read-only grace period measured from the first failed payment/);
  assert.match(termsSource, /grace period is not extended by\s+later payment attempts/);
  assert.match(termsSource, /Fees are\s+non-refundable and non-creditable/);
  assert.match(termsSource, /duplicated or made in error/);
  assert.doesNotMatch(termsSource, /AI subscription|AI credits|trial credits/);
  assert.match(termsSource, /does not combine with another offer/);
  assert.match(termsSource, /at least 30 days&apos; advance notice/);
  assert.doesNotMatch(termsSource, /self-service monthly subscription\s+automatically renews/);
  assert.match(termsSource, /FOR A PAID SERVICE[\s\S]*SERVICE FEES CUSTOMER ACTUALLY PAID/);
  assert.match(termsSource, /FOR A FREE OR NO-FEE SERVICE[\s\S]*USD \$100/);
  assert.match(termsSource, /USD \$100 CAP IS NOT ADDED TO OR USED AS A MINIMUM/);
  assert.match(termsSource, /Mutual third-party indemnities for Business Customers/);
  assert.match(termsSource, /base cap in Section 18 does not apply/);
  assert.match(termsSource, /governed by Delaware law/);
  assert.match(termsSource, /do not require\s+arbitration/);
  assert.match(termsSource, /try in good faith for 30 days/);
});

test("cookie notice truthfully describes only current necessary storage", () => {
  assert.match(cookiesSource, /only storage that is necessary/);
  assert.match(cookiesSource, /IndexedDB or OPFS/);
  assert.match(cookiesSource, /operating system credential store/);
  assert.match(cookiesSource, /does not currently use advertising cookies/);
  assert.match(cookiesSource, /accept, refuse,[\s\S]*withdrawal controls/);
});

test("legal documents stay discoverable before and after sign-in", () => {
  for (const href of ["/privacy", "/terms", "/cookies", "/subprocessors"]) {
    assert.match(footerSource, new RegExp(`href: "${href}"`));
    assert.match(settingsSource, new RegExp(`href="${href}"`));
    assert.match(legalDocumentSource, new RegExp(`href: "${href}"`));
  }
  assert.match(loginSource, /By continuing, you agree/);
  assert.match(loginSource, /href="\/privacy"/);
  assert.match(loginSource, /href="\/terms"/);
  assert.match(settingsSource, /contact@madebyrobot\.net/);
});

test("legal surfaces contain no template markers or nested glass treatment", () => {
  const legalSources = [
    privacySource,
    termsSource,
    cookiesSource,
    subprocessorsSource,
    legalDocumentSource,
  ];
  for (const source of legalSources) {
    assert.doesNotMatch(source, /TODO|TBD|\[INSERT|placeholder/i);
    assert.doesNotMatch(source, /LiquidGlass|backdrop-filter/);
  }
});
