# Search and agent discovery

Updated 21 October 2026. The canonical public page is
https://bendboundapp.com/. The app is still an early iPhone beta; public downloads
and TestFlight invitations are not open. These facts must stay consistent across
HTML, JSON-LD, Markdown, sharing cards and future release updates.

## What is published

- A descriptive title and summary identifying motorcycle route planning and GPS
  ride recording, a canonical URL and index/follow metadata.
- WebSite, WebPage and MobileApplication JSON-LD, with linked entity identifiers,
  actual feature descriptions, iOS platform, beta status and real screenshots.
- Four visible questions and answers, delivered in the initial HTML without
  JavaScript or collapsed controls: downloads, round trips, GPX and Android.
- A 1200 × 630 Open Graph / Twitter sharing card composed from the unchanged
  approved logo and an authentic app screenshot. It is not a generated product image.
- /index.md: a concise Markdown version of the public product information.
- /llms.txt: a small directory linking to that Markdown, the site and source project.
- HTML and HTTP Link relations advertise the Markdown alternate and llms.txt.
  Markdown responses carry text/markdown and a canonical link to the homepage.
- robots.txt remains open to all crawlers and explicitly permits OAI-SearchBot.
  This does not alter the existing training-crawler policy.
- sitemap.xml lists the canonical homepage with its actual content-update date.
- A root IndexNow ownership file and scripts/submit-indexnow.py for notifying
  participating search engines after a changed release is deployed. Its key is
  intentionally published for domain verification; it is not an AWS credential.

## Security and accuracy

The existing content security policy remains restrictive. Only the exact JSON-LD
block is allowed by a SHA-256 hash calculated from the shipped HTML. Executable
inline JavaScript is still blocked; unsafe-inline was not added. Discovery files
use short caches so future availability updates can be refreshed promptly.

There are no invented prices, App Store links, offers, ratings or reviews in the
structured data. MobileApplication markup describes the product; it is not a claim
of Google software-app rich-result eligibility. Google's app rich results require
an offer and review/rating data that this early-beta site does not have.
[Google software application documentation](https://developers.google.com/search/docs/appearance/structured-data/software-app).

llms.txt is a supplemental proposal, not a ranking signal or access-control file.
The standard searchable HTML, useful content and crawl access remain the foundation.
[Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features),
[llms.txt proposal](https://llmstxt.org/).

OAI-SearchBot handles OpenAI search discovery separately from training crawlers.
[OpenAI crawler documentation](https://developers.openai.com/api/docs/bots).
IndexNow receipts confirm submission, not indexing or ranking.
[IndexNow documentation](https://www.indexnow.org/documentation).

## Validation and maintenance

Run the root lint/typecheck and the website's eight handler/discovery tests. The
browser review covers 1440, 768 and 390px; interaction checks cover twelve widths,
including visible questions, valid JSON-LD, no-script fallback, tab keyboard flow,
no overflow and no JavaScript exceptions under the actual Lambda response headers.
The approved few-pictures allowance remains because the fourth screenshot appears
only when selected in the feature tour. No-footage is intentional.

After deploying and completing the CloudFront invalidation:

1. Run scripts/verify.py. It checks exact live release hashes, new discovery routes,
   metadata response headers, crawler user-agent access and origin protections.
2. Run scripts/submit-indexnow.py once for that changed release. The script verifies
   the deployed ownership file first and writes indexnow-submission.json. Do not
   repeatedly submit unchanged content or interpret HTTP 200/202 as proof of indexing.
3. Use Google Search Console to verify ownership, submit /sitemap.xml and inspect
   the homepage for indexing. Search Console account verification and URL inspection
   have not been performed in this task. No Google indexing or AI citation is claimed.

When public distribution opens, update the visible availability and questions,
index.md, llms.txt, JSON-LD, meta descriptions and social card together. Publish only
real store/download destinations and confirmed pricing. Update sitemap lastmod
when the public content actually changes, then deploy and notify IndexNow.

## Deployment evidence — 21 October 2026

The release is live. AWS stack UPDATE_COMPLETE; CloudFront Deployed; invalidation
Completed. Live release hashes, discovery MIME types/links, crawler user-agent
access, structured-data parsing and browser behavior pass. IndexNow returned
HTTP 202, meaning receipt with ownership verification pending. See deployment.json,
verification.json and indexnow-submission.json. No actual search indexing, ranking
improvement or AI citation has been verified.
