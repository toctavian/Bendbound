# Bendbound website

A buildless, one-page promotional website for the iPhone app, served from AWS
Lambda in eu-west-2 through CloudFront at https://bendboundapp.com.

## Preview

From this directory:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory public
```

## Checks

```sh
node --check public/site.js
/opt/homebrew/bin/python3 -m unittest discover -s tests
```

The root app's lint and typecheck also pass. Browser QA covers 1440, 768 and 390px,
including the feature tour and keyboard selection. `DESIGN.md` records the brand
and intentional design-scan allowances.

## Deploy

Use Python 3.11+ (Homebrew Python on this Mac). Every AWS resource call goes
through the AWS MCP command and profile configured in `~/.codex/config.toml`.
`scripts/aws-mcp.py` is a stdio client for that exact MCP connection; it is used
because the current chat's AWS tool wrapper reports Unknown tool. No local boto3
or AWS CLI resource operations are used.

If authentication fails, first run `aws login --profile bendbound --region eu-west-2`
and allow the fresh browser flow to finish, then retry MCP. Do not save login or
presigned URLs or credentials.

```sh
/opt/homebrew/bin/python3 scripts/deploy.py
```

This packages only `handler.py` and `public/`, obtains a presigned S3 upload URL
from MCP, uploads the ZIP in memory, validates the CloudFormation template, then
creates or updates stack `bendbound-website`. CloudFront serves a Lambda Function
URL with AWS_IAM auth and OAC-signed origin access. Lambda grants only this
CloudFront distribution permission to invoke the URL. HTTPS is enforced; www
redirects to the apex. Existing api.bendboundapp.com records are preserved.

The bootstrap artifact bucket and issued us-east-1 ACM certificate were created
through MCP; identifiers and artifact hash are in `deployment.json`. The bucket
blocks public access. The Lambda role only writes its own 14-day CloudWatch logs.
There is no website database, analytics service, cookie tracking or waitlist.

For updates, wait for the stack to complete, then invalidate `/*` on the recorded
CloudFront distribution through AWS MCP. `deployment.json` records the deployed
artifact; an earlier artifact key can be used to roll back through UpdateStack.
Do not delete or replace unrelated app infrastructure.

## Content and assets

The approved logo is copied unchanged from `../assets/bendbound-logo.png`.
Screenshots are WebP conversions of fresh native simulator captures from
`../output/website-captures/2026-10-21/`, taken from a local Xcode Release build
of the current checkout. Original captures are retained locally; `screenshots.json`
records their hashes and dimensions. The saved tours are the app's existing example routes,
labelled as examples. No stock photography or generated assets are used.

The app remains an early beta. Until a public App Store or TestFlight URL is
provided, the site points to the public project and says downloads are not open.
Update that copy and the main button together when public distribution begins.

## Verified deployment

Updated 21 October 2026: CloudFormation `UPDATE_COMPLETE`, CloudFront `Deployed`,
cache invalidation completed. Public smoke checks passed
for HTML/CSS/JS, screenshot assets, robots/sitemap, HTTPS and www redirects, 404s,
security headers and the unsigned-origin 403. Every served file, including all four
app screenshots, matches the local release SHA-256. Live browser inspection and
feature-tour keyboard checks pass at desktop, tablet and phone sizes. See
`verification.json` and the deployment entry in `review.md`.

At launch the Mac's default resolver retained an earlier negative domain lookup.
Authoritative Route53 and public 1.1.1.1 DNS returned the published CloudFront
addresses. Checks used `scripts/verify.py --dns-server 1.1.1.1`, which resolves only
inside that process and preserves normal TLS hostname/certificate verification;
it changes no system DNS settings. New DNS records may take time to reach every
resolver. Retry the plain verifier once local DNS has refreshed.

## Search and AI-agent discovery

SEO.md documents metadata, structured product data, crawler access, Markdown,
llms.txt, social sharing and IndexNow. Discovery and structured-data tests are
included in the standard website test command. After a verified deployment,
run scripts/submit-indexnow.py once to notify participating search engines.
Notification receipt does not guarantee indexing. Google Search Console ownership
verification and URL inspection remain a separate account step.
