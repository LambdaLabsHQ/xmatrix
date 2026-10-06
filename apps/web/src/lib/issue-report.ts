/** Feedback is a public GitHub issue on the xMatrix repository. */
const ISSUE_FORM_URL = "https://github.com/LambdaLabsHQ/xmatrix/issues/new";

/** The "Report a problem" form, its Environment field filled from the app. */
export function issueReportUrl(environment: string): string {
  const params = new URLSearchParams({ template: "report.yml", environment });
  return `${ISSUE_FORM_URL}?${params.toString()}`;
}
