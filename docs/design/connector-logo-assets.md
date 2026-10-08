# Connector logo assets

Connector message authors and the Apps list use the same local files in
`apps/web/public/app-connectors/`. Keep these provider marks recognizable at
avatar size; do not replace them with font initials. Render the vendor artwork
directly with its original aspect ratio and a transparent surrounding canvas.
Do not add a white backplate, a nested SVG viewport, or inset padding.
The UI sets the icon size without another decorative container.

## Sources

The SVG Logos assets are pinned to
`gilbarbara/logos@37a6b807fd71c622efea27a9309b5d4edc792969`.
The Simple Icons assets are pinned to
`simple-icons/simple-icons@9f1c11219a45e1440271e98a143490594a4aba6d`.
Original vendor colors and geometry are retained. Feishu uses the colored mark
from its official portal logo, without the wordmark. DingTalk embeds the
unmodified 192px official portal PNG. The file paths stay unchanged so existing
message snapshots resolve to the updated marks.

[SVG Logos license](https://github.com/gilbarbara/logos/blob/37a6b807fd71c622efea27a9309b5d4edc792969/LICENSE.txt)
and [Simple Icons license and brand guidance](https://github.com/simple-icons/simple-icons/blob/9f1c11219a45e1440271e98a143490594a4aba6d/DISCLAIMER.md)
apply to their respective source assets. Vendor marks remain the property of
their respective owners; these assets identify integrations with those products.

| Provider | Asset source |
| --- | --- |
| bitbucket | [Bitbucket](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/bitbucket.svg) |
| buildkite | [Buildkite](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/buildkite-icon.svg) |
| circleci | [CircleCI](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/circleci.svg) |
| cloudflare | [Cloudflare](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/cloudflare-icon.svg) |
| dingtalk | [DingTalk](https://gw.alicdn.com/imgextra/i2/O1CN01E2nAxu1lQPOP7InyV_!!6000000004813-2-tps-192-192.png) |
| discord | [Discord](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/discord-icon.svg) |
| feishu | [Feishu](https://sf3-scmcdn-cn.feishucdn.com/goofy/ee/suite/passport/static/login/img/logo-py-ig.be16a08a.svg) |
| gitlab | [GitLab](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/gitlab-icon.svg) |
| google | [Google](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/google-icon.svg) |
| googlechat | [Google Chat](https://raw.githubusercontent.com/simple-icons/simple-icons/9f1c11219a45e1440271e98a143490594a4aba6d/icons/googlechat.svg) |
| googlesearchconsole | [Google Search Console](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/google-search-console.svg) |
| grafana | [Grafana](https://raw.githubusercontent.com/simple-icons/simple-icons/9f1c11219a45e1440271e98a143490594a4aba6d/icons/grafana.svg) |
| jira | [Jira](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/jira.svg) |
| linear | [Linear](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/linear-icon.svg) |
| netlify | [Netlify](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/netlify-icon.svg) |
| notion | [Notion](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/notion-icon.svg) |
| opsgenie | [Opsgenie](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/opsgenie.svg) |
| pagerduty | [PagerDuty](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/pagerduty-icon.svg) |
| sentry | [Sentry](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/sentry-icon.svg) |
| slack | [Slack](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/slack-icon.svg) |
| stripe | [Stripe](https://raw.githubusercontent.com/simple-icons/simple-icons/9f1c11219a45e1440271e98a143490594a4aba6d/icons/stripe.svg) |
| teams | [Microsoft Teams](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/microsoft-teams.svg) |
| telegram | [Telegram](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/telegram.svg) |
| vercel | [Vercel](https://raw.githubusercontent.com/gilbarbara/logos/37a6b807fd71c622efea27a9309b5d4edc792969/logos/vercel-icon.svg) |
| wecom | [WeCom](https://wwcdn.weixin.qq.com/node/wework/images/WWLogo.08631f189a.svg) |

The existing GitHub mark and generic Webhook glyph are retained. OpenConnector
is a user-supplied runtime rather than one vendor, so it uses a neutral connected
links glyph instead of an invented brand or a letter placeholder.
