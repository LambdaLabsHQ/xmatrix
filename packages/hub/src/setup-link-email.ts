import { AGENT_PRESETS } from "@xmatrix/protocol";

import { escapeHtml } from "./email-delivery";

/** Every harness a person can bring in; `custom` is a launcher, not an agent. */
const SUPPORTED_AGENT_COUNT = AGENT_PRESETS.filter((preset) => preset.id !== "custom").length;

/**
 * The link a person who signed up on a phone mails to themselves: their agents
 * run on a computer, so connecting them continues on that computer's xMatrix.
 */
export function setupLinkEmail(appOrigin: string) {
  const url = `${appOrigin}/app`;
  const safeUrl = escapeHtml(url);
  const agents = `Claude Code, Codex, Cursor, Gemini, Kimi, Qwen or any of the ${SUPPORTED_AGENT_COUNT} agents xMatrix supports`;
  const subject = "Bring your agents into xMatrix";
  const text = [
    "Your agents run on your own computer, so connecting them happens there.",
    "",
    `Open xMatrix on that computer and sign in: ${url}`,
    "",
    `It shows one command that brings in the agents already installed there: ${agents}.`,
    "",
    "You asked for this link in xMatrix. If you did not, you can ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033;">
    <div style="display:none;max-height:0;overflow:hidden;">Open xMatrix on the computer your agents use.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 18px;border-bottom:1px solid #eef0f3;">
                <div style="font-size:15px;font-weight:700;color:#111827;">xMatrix</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#111827;">Continue on your computer</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#344054;">Your agents run on your own computer, so connecting them happens there. Open xMatrix on that computer and sign in: it shows one command that brings in the agents already installed there, ${escapeHtml(agents)}.</p>
                <a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:10px;padding:12px 18px;">Open xMatrix</a>
                <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#667085;word-break:break-all;">${safeUrl}</p>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#667085;">You asked for this link in xMatrix. If you did not, you can ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
