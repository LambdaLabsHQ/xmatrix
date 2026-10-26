import { RuleTester } from "eslint";
import rule from "./no-page-id-display.mjs";

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module", parserOptions: {
  ecmaFeatures: { jsx: true },
} } });

tester.run("no-page-id-display", rule, {
  valid: [
    "const C = ({pageId, title}) => <button key={pageId} data-page-id={pageId} onClick={() => open(pageId)}>{title}</button>",
    "const C = ({pageId}) => <PageReferenceChip span={{kind: 'page', pageId}} />",
    "const C = ({pageId, titles}) => <span>{titles.get(pageId) || 'Page'}</span>",
    "const C = ({pageId}) => <a href={`/pages?page=${pageId}`}>Open page</a>",
    "const C = ({pageId}) => <input value={pageId} />",
    "const C = ({pageId}) => <span>{pageId ? 'Page' : 'None'}</span>",
    "const C = ({pageId}) => <span>{pageId && <b>Page</b>}</span>",
    "const C = ({pageId}) => { const label = titleFor(pageId); return <span>{label}</span> }",
    "const C = ({pageId}) => <span>{[pageId].map((pageId) => <b key={pageId}>Page</b>)}</span>",
  ],
  invalid: [
    "const C = ({pageId}) => <span>{pageId}</span>",
    "const C = ({page}) => <span>{page.pageId}</span>",
    "const C = ({page}) => <span>{page['pageId']}</span>",
    "const C = ({page}) => <span>{page?.id}</span>",
    "const C = ({parentPageId}) => <span title={parentPageId}>Page</span>",
    "const C = ({pageId}) => <span aria-label={`Open ${pageId}`}>Page</span>",
    "const C = ({pageId}) => <span>{'Page ' + pageId}</span>",
    "const C = ({title, pageId}) => <span>{title || pageId}</span>",
    "const C = ({pageId}) => <span>{String(pageId).slice(0, 8)}</span>",
    "const C = ({pageId}) => { const label = pageId; return <span>{label}</span> }",
    "const C = ({page}) => { const {pageId: label} = page; return <span>{label}</span> }",
    "const C = ({pageId: label}) => <span>{label}</span>",
    "const C = ({pageId}) => <span>{[pageId, 'Page']}</span>",
    "const C = ({pageId, el}) => { el.textContent = pageId; return null }",
  ].map((code) => ({ code, errors: [{ messageId: "raw" }] })),
});
