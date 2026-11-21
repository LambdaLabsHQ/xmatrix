import { escapeHtml } from "./email-delivery";

/**
 * The feedback-for-Pro invitation (docs/operations/billing-grants.md). The
 * wording is fixed here so what people receive is what was reviewed.
 */
export const FEEDBACK_PRO_CAMPAIGN = "feedback-pro-2026-11";
export const FEEDBACK_REPLY_TO = "hello@xmatrix.sh";
const ISSUES_URL = "https://github.com/LambdaLabsHQ/xmatrix/issues";

export function feedbackProEmail(unsubscribeUrl: string): { subject: string; text: string; html: string } {
  const subject = "帮我们改进 xMatrix，送你一个月 Pro / Help improve xMatrix, get a month of Pro";
  const zh = [
    "你好，",
    "你之前注册过 xMatrix。想请你帮个忙：告诉我们你在哪一步卡住了，或者哪里用着不顺手。",
    "只要说清楚在哪一步、你做了什么、看到了什么（附截图更好），我们就送你名下的一个 Space 一个月 Pro（每席 5,000 credit）。到期自动回到 Free，不扣费，也不用绑卡。",
    "两种方式都可以：直接回复这封邮件；或者在 GitHub 提 issue（" + ISSUES_URL + "），并在正文里写上你的 xMatrix 用户名，方便我们对上账号。issue 是公开的，请不要贴 token、日志里的路径或邮箱；涉及隐私的请用邮件回复。",
    "不一定非得是 bug，「我不知道下一步该干什么」也很有价值。每人限一次，重复的问题也算。",
    "谢谢！\nxMatrix 团队",
  ];
  const en = [
    "Hi,",
    "You signed up for xMatrix a while ago. Could you tell us where you got stuck, or what felt off?",
    "Tell us where it happened, what you did, and what you saw (a screenshot helps), and we'll give one Space you own a month of Pro (5,000 credits per seat). It returns to Free on its own: no charge, no card needed.",
    "Either way works: reply to this email, or open a GitHub issue (" + ISSUES_URL + ") with your xMatrix username so we can find your account. Issues are public; please don't paste tokens, log paths or email addresses. Reply by email for anything private.",
    "It doesn't have to be a bug. \"I didn't know what to do next\" is useful too. One month per person; duplicate reports count.",
    "Thanks,\nThe xMatrix team",
  ];
  const footer = `不想再收到这类邮件 / Unsubscribe: ${unsubscribeUrl}`;
  const text = [...zh, "---", ...en, "", footer].join("\n\n");
  const paragraph = (line: string) => `<p>${escapeHtml(line).replace(/\n/g, "<br>")}</p>`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;line-height:1.6;max-width:600px">
${zh.map(paragraph).join("\n")}
<hr>
${en.map(paragraph).join("\n")}
<p style="color:#666;font-size:12px"><a href="${escapeHtml(unsubscribeUrl)}">不想再收到这类邮件 / Unsubscribe</a></p>
</body></html>`;
  return { subject, text, html };
}
