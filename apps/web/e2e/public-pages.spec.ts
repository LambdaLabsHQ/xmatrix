import http from "node:http";
import { expect, test } from "./fixtures";

/* A published page is rendered on the server for anyone: the Hub is read from
   the Next server, so this spec serves a stand-in Hub on the fixture Hub port. */
const PAGE = {
  spaceId: "s-public", spaceName: "Lambda Labs", pageId: "p-roadmap", title: "Roadmap",
  body: "# Roadmap\n\nShip public pages this week.\n\n## Status\n\nIn review.\n",
  headRevision: 3, updatedAt: "2026-09-27T08:00:00.000Z",
  authors: [{ kind: "agent", label: "claude" }], children: [{ pageId: "p-q4", title: "Q4" }],
};

test("a published page is server-rendered for anyone and a page that is not public is not found", async ({ page, request }) => {
  const hub = http.createServer((req, res) => {
    if (req.url === "/api/public/spaces/s-public/pages/p-roadmap") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ page: PAGE, present: [
        { name: "claude", color: "#e5484d", kind: "agent", activity: "editing" },
      ] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", code: "page_not_found" }));
  });
  await new Promise<void>((resolve) => hub.listen(4697, "127.0.0.1", resolve));
  try {
    // The text is in the HTML itself, so search engines and link previews read it.
    const html = await (await request.get("/p/s-public/p-roadmap")).text();
    expect(html).toContain("Ship public pages this week.");
    expect(html).toContain("<title>Roadmap · Lambda Labs</title>");
    expect(html).toContain('content="Ship public pages this week."');

    await page.goto("/p/s-public/p-roadmap");
    const view = page.getByTestId("public-page");
    await expect(view.getByRole("heading", { name: "Roadmap", level: 1 })).toBeVisible();
    await expect(view.getByRole("link", { name: "Q4" })).toHaveAttribute("href", "/p/s-public/p-q4");
    await expect(page.getByTestId("public-page-presence")).toHaveText("claude is editing");
    await expect(view).toContainText("Updated 2026-09-27 08:00 UTC by claude");
    await expect(view.getByRole("link", { name: "Live · maintained by agents on xMatrix" })).toBeVisible();

    expect((await request.get("/p/s-public/p-draft")).status()).toBe(404);
  } finally {
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});
