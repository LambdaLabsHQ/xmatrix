const assert = require("node:assert/strict");
const test = require("node:test");

async function load() {
  return await import("./store-legal.ts");
}

test("the App Store purchase links Apple's standard EULA and the privacy policy", async () => {
  const { storeLegalLinks, APPLE_STANDARD_EULA_URL } = await load();
  const links = storeLegalLinks("apple");
  assert.deepEqual(links.map((link) => link.href), [APPLE_STANDARD_EULA_URL, "/privacy", "/terms"]);
  assert.equal(links[0].label, "Terms of Use (EULA)");
  assert.equal(links[0].external, true);
});

test("Google Play keeps the privacy policy and Terms of Service without Apple's EULA", async () => {
  const { storeLegalLinks, APPLE_STANDARD_EULA_URL } = await load();
  const hrefs = storeLegalLinks("google").map((link) => link.href);
  assert.ok(!hrefs.includes(APPLE_STANDARD_EULA_URL));
  assert.deepEqual(hrefs, ["/privacy", "/terms"]);
});

test("a plan label names the subscription, its length and its price", async () => {
  const { storePlanLabel } = await load();
  assert.equal(storePlanLabel({ title: "xMatrix Pro Monthly", interval: "month", displayPrice: "$10.00" }),
    "xMatrix Pro Monthly · 1 month · $10.00/month");
  assert.equal(storePlanLabel({ title: "xMatrix Pro Annual", interval: "year", displayPrice: "$96.00" }),
    "xMatrix Pro Annual · 1 year · $96.00/year");
});
