ROUND 2
Seen in one second: A motorcycle app, its route map and the real controls.
Idea (one sentence): Find the next ride, with the road shown inside the sentence
and the app itself supplying the proof.
Live thing: A three-state feature tour with matching screenshots, copy and captions.
Layout words by section: hero=sentence+phone / app=interactive-proof /
details=two-column-editorial / availability=flat-band / footer=brand-close
Scores: design 6.5 · usability 8 · creativity 7 · content 8 → overall 7.2
Caps applied: screenshot-only product presentation has fewer than four real-world
photographs; intentional. No attempt to inflate the score or add irrelevant imagery.
Top three problems from round 1, now resolved in the final screenshots:
1. Mobile words joined where br was hidden. Added separating spaces.
2. Mobile details heading occupied three lines. Replaced with Keep the ride.
3. Ten desktop type sizes. Consolidated to five.

Final independent verdict: ship. Reviewer inspected desktop, tablet and mobile
fold/page captures and found no remaining material layout/readability issues.
Inspector: 0 FAIL with declared few-pictures allowance; no-footage and still-page
warnings retained intentionally for a simple, restrained app promotion.
Impeccable detector's two cramped-padding warnings are false positives: the
sections have vertical padding and inset .wrap children, visible in all captures.

## Responsive bug-fix review — 21 October 2026

Local source review; these changes have not been deployed. Existing direction
retained: The sentence is the layout, seed 289185989; no redraws, new assets or
sample content. On this page, Bendbound’s saved route becomes the window inside
“Find your next ride.” The live thing remains the three-state app screenshot tour.

ROUND 1 (before this fix)
Seen in one second: A route inside the title, beside the real iPhone app.
Idea (one sentence): The winding route joins the invitation to find the next ride.
Live thing: Planning, recording and saved-tour previews.
Layout words by section: hero=sentence+phone / app=interactive-proof /
details=editorial / availability=flat-band / footer=brand-close
Scores: design 6.5 · usability 8 · creativity 7 · content 8 → overall 7.2
Caps applied: Three distinct real app screenshots; fewer than four pictures.
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. Phone feature controls wrap into two rows at 320px (browser measurement;
   before/mobile-page-01.jpg shows the same controls at 390px). Use three equal
   columns, retaining 48px touch targets.
2. Switching to saved tours grows the product block by about 24px at desktop,
   tablet and phone widths (interaction measurements). Give screenshots a stable
   aspect ratio and reserve two caption lines without cropping the app.
3. The phone feature copy reserves 180px even when it is shorter
   (before/mobile-page-01.jpg). Reduce the reservation at wider phone sizes while
   keeping room for the longest description at narrow widths.

ROUND 2 (after fixes)
Seen in one second: The same clear route-led invitation and native app.
Idea (one sentence): The winding route joins the invitation to find the next ride.
Live thing: The feature tour, with stable sizing and keyboard selection.
Layout words by section: hero=sentence+phone / app=interactive-proof /
details=editorial / availability=flat-band / footer=brand-close
Scores: design 6.5 · usability 8.5 · creativity 7 · content 8 → overall 7.4
Caps applied: Fewer than four distinct pictures; the existing three genuine app
screenshots are retained. This remains a restrained product page, below 7.5.
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. Responsive controls and preview movement are resolved (after/feature-save-390.jpg,
   after/feature-save-768.jpg, after/feature-save-1440.jpg; twelve-width browser checks).
2. Mobile description spacing is reduced (after/mobile-page-01.jpg). The longest
   feature description determines the reserved space at each responsive range.
3. An additional inspector run exposed the hero title remaining faded while its
   entrance animation was delayed. The entrance now moves without hiding text;
   the title is fully readable from the first paint.

Additional fixes: navigation/text-link hover colours now require hover-capable,
precise input; controls disable text selection; landscape text inflation is
controlled without disabling zoom. Each tab identifies both the text panel and
its screenshot; the screenshot’s accessible label follows the selected tab.
When JavaScript is unavailable, inactive tour controls are hidden and the initial
planning description and screenshot remain readable.

Evidence: `.taste-skill/before/` and `.taste-skill/after/` contain browser screenshots
and measurements (local generated artifacts, excluded from Git). Interaction checks
cover 320, 360, 375, 390, 430, 500, 650, 651, 700, 768, 1024 and 1440px: no horizontal
overflow, stable downstream position across every feature, 44px-plus tab targets,
ArrowLeft/ArrowRight/Home/End selection and focus, valid preview labels and no JS
exceptions. JavaScript-disabled fallback also passes. This is browser emulation;
physical phone/Safari touch and landscape behavior remain unverified.

No footage and modest motion remain intentional for the existing simple product
page. No stock pictures, drawings or invented proof were added; image licences
and attribution are unchanged.

Final validation: taste inspector at 1440/768/390px reports 0 FAIL with the
existing `few-pictures` allowance; no-footage and still-page warnings are retained
for the reasons above. All six final fold/page screenshots were opened and
reviewed. Root lint and TypeScript checks pass; website JavaScript syntax, four
handler tests, source taste lint and Git whitespace checks pass.

## Fresh app screenshots and re-review — 21 October 2026

All three website screenshots were replaced with captures from a successful local
Xcode Release build of the current working tree, running on iPhone 16 Pro / iOS
18.6. The previous installed simulator app was older; the fresh build avoids its
development warning overlay. No app source was changed for capture. Map, round-trip
planner and Saved were opened through Device Hub. No recording or account action
was started. The saved routes remain the existing Triglav and Surrey Hills examples.

Original PNGs: `../output/website-captures/2026-10-21/`. Website assets: map.webp,
planner.webp and tours.webp. Each is 1206 × 2622px, converted directly to WebP at
quality 88, without retouching or cropping. `screenshots.json` records file hashes,
dimensions and provenance. Total WebP payload is 439,760 bytes. Content-hash query
strings give browsers fresh image URLs; the existing deployment still requires
its normal CloudFront invalidation. HTML dimensions and the preview aspect ratio
now match the captured 402 × 874pt screen. Planner alt text describes the controls
actually visible in the new capture.

ROUND 1 (fresh assets)
Seen in one second: A winding route inside the title and the current native map.
Idea (one sentence): Bendbound’s saved example route becomes the window inside
“Find your next ride.”
Live thing: The three-state tour of planning, recording and saved routes.
Layout words by section: hero=sentence+phone / app=interactive-proof /
details=editorial / availability=flat-band / footer=brand-close
Scores: design 6.5 · usability 8.5 · creativity 7 · content 8 → overall 7.4
Caps applied: Three distinct real app screenshots; the existing few-pictures
allowance remains deliberate. This is a modest refresh, not a claimed increase
in visual-design quality.
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. The previous assets no longer showed the current app build. All three are now
   direct captures of the newly built app (after/desktop-page-01.jpg and
   after/feature-save-1440.jpg).
2. The planner is taller than one native sheet viewport. The new screenshot shows
   its distance, cone angle and route preference faithfully; heading, motorway and
   create controls remain below the app’s scroll position. Alt text no longer
   claims those controls are visible (after/tablet-page-01.jpg).
3. A narrow phone still shows the preview below its explanatory copy. Tab targets
   remain in one row, text remains readable and image/caption sizing stays stable
   (after/mobile-page-01.jpg and after/feature-save-390.jpg). The current layout is
   retained; a more compact interactive phone composition remains a future design
   opportunity, not a new defect introduced by these images.

No stock imagery, generated artwork, new sample content or attribution changes.
Direction retained: The sentence is the layout, seed 289185989; no redraws.

## Design improvement pass — 21 October 2026

ROUND 1 (baseline)
Seen in one second: A route inside the title and a small native app screenshot.
Idea (one sentence): Bendbound’s saved example route becomes the window inside
“Find your next ride.”
Live thing: Three feature tabs, separated from their visual result on phones.
Layout words by section: hero=sentence+phone / app=interactive-proof /
details=editorial / availability=flat-band / footer=brand-close
Scores: design 6.5 · usability 8.5 · creativity 7 · content 8 → overall 7.4
Caps applied: Three distinct screenshots limited the imagery score.
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. A narrow product screenshot and 80px desktop margins make the app feel small
   (score-before/desktop-fold.jpg). Tighten margins to 40px at 1440px and enlarge
   the hero screenshot from 292px to 320px.
2. Explanatory copy and reserved space separate phone tabs from their result
   (score-before/mobile-page-01.jpg). Put the tabs immediately above the preview,
   inside one flat product stage.
3. The lower page becomes text-only and drops the route-led idea
   (score-before/desktop-page-01.jpg). Show an actual saved route’s native detail
   screen at readable scale, beside the practical saving/GPX explanation.

ROUND 2 (final)
Seen in one second: The route-led invitation and a larger, clearer native map.
Idea (one sentence): The saved route starts inside the title, can be explored in
an app preview, and returns as the actual route detail further down the page.
Live thing: A feature selector directly attached to its screenshot, plus a link
from the route-detail crop to the full native capture.
Layout words by section: hero=sentence+phone / app=controls+product-stage /
details=route-proof+copy / availability=flat-band / footer=brand-close
Scores: design 7.5 · usability 8.5 · creativity 7 · content 8 → overall 7.8
Caps applied: None. Four distinct native app captures now provide relevant proof;
no screenshot was invented to satisfy the picture count. This is my visual
assessment using the same rubric, not an independent jury rating.
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. The product is clearer at desktop size and the outer frame is tighter
   (after/desktop-fold.jpg). Hero media share rises from 14% to 17%.
2. Selecting a feature now changes the screenshot immediately below the controls
   (after/feature-save-390.jpg and after/feature-save-768.jpg). Controls remain in
   one row at 320px. The preview is a focusable tab panel; its description is
   announced politely, and Tab/Shift-Tab follow the visual selector.
3. The saved-route section now carries a real, legible map and its native metrics
   (after/desktop-page-01.jpg and after/mobile-page-01.jpg). The CSS crop stops
   after the route measurements; the full screenshot is available through the
   image or “View full screen”. Its caption explicitly identifies an example.

The additional route-detail capture comes from the same current-source Xcode
Release app on iPhone 16 Pro, iOS 18.6. Source PNG:
`../output/website-captures/2026-10-21/route-detail.png`. Asset and hashes are in
`screenshots.json`. This is the existing Triglav example, not a new ride or an
invented customer result. No app source, group/account state or recordings were
changed. The unchanged approved logo, system font and established palette remain.
Direction: The sentence is the layout, seed 289185989; no redraws. No found or
stock imagery, generated artwork, sample copy requiring replacement, or new
attribution obligations were introduced.

Motion now includes a slow, small drift within the route window and entrances
for the newly added proof and footer elements. Reduced-motion mode removes these
movements and keeps all content present. The inspector observes 19 moving elements
(previously 14), resolving its still-page warning. No-footage remains the sole
warning: a video would add weight without explaining these static native controls
better. The four real app screenshots need no imagery allowance.

Remaining limitations: the hero is still a familiar product composition, so
creativity stays at 7; this is not an 8.5–9 design. The phone page remains a long
read. Physical-device Safari/touch remains unverified. Availability remains the
honest early-beta message; no public download destination was supplied. Website
changes remain local and have not been deployed.

Final validation for this pass: inspector 0 FAIL / 1 WARN at 1440, 768 and 390px,
without allowances. All seven final inspector screenshots were opened and
reviewed. Twelve-width browser checks pass, including stable feature switching,
no horizontal overflow, 44px-plus targets, Arrow/Home/End navigation, Tab into the
preview and Shift-Tab back, and the JavaScript-disabled fallback. No browser JS
exceptions. Root lint and typecheck, website JavaScript syntax, source taste lint,
four handler tests and Git whitespace checks pass.

## Deployed and verified — 21 October 2026

Published the reviewed changes to https://bendboundapp.com through the configured
AWS MCP connection. CloudFormation is UPDATE_COMPLETE; CloudFront is Deployed and
its /* invalidation is Completed. Release artifact SHA-256:
`b9fdb99de27bef80fecc5e4f3274273d10f736903b3263ffd2eb80284ee347ef`.
The previous artifact key is preserved in deployment.json for rollback.

Public HTTPS checks passed using normal system DNS. HTML, CSS, JavaScript, all
four screenshot assets, robots.txt and sitemap.xml match the local release hashes.
HTTPS/www redirects, security headers, 404 behavior and unsigned Lambda origin
403 passed. Evidence: verification.json.

The live site was inspected at 1440, 768 and 390px: 0 FAIL, with the existing
no-footage warning only; no allowances. All seven generated live fold/page
screenshots were opened and reviewed. Live feature switching, stable sizing,
keyboard arrows/Home/End, Tab/Shift-Tab, touch targets, no horizontal overflow and
no-script fallback passed at those three viewports, with no JS exceptions.
Live browser evidence is retained locally in .taste-skill/live/. The visual score
remains 7.8/10. Physical-device Safari remains unverified.

## Header crop fix — 21 October 2026

Removed the road-window image from the main headline after the user identified
its awkward crop. Removed its CSS, mobile override and drift animation as well.
The headline is now plain “Find your next ride.” over two lines, beside the
complete app screenshot. This supersedes the earlier embedded-route design notes;
no new numerical design score is assigned to this focused correction.

Deployed through AWS MCP. CloudFormation UPDATE_COMPLETE, CloudFront Deployed,
cache invalidation Completed. Artifact SHA-256:
`0c7837a9d867c61428fe2205cf37fc0045252c452e4b544048ee6024c5d8d831`.
Public file hashes match the local release; HTTPS/redirect/security/origin checks
pass. Dedicated live browser assertions confirm the crop is absent, the headline
is correct, and there is no overflow or JavaScript exception at 1440, 768 and 390px.
Root lint/typecheck, JavaScript syntax, four handler tests and source taste lint pass.

Removing the decorative tours crop leaves three screenshots visible initially;
the fourth (Saved) appears when selected in the tour. The local full-page meter
flags its static few-pictures rule. The live scan explicitly allows that count,
rather than adding a new decorative image to replace the one the user disliked.
All four real app screenshot assets remain available. No video remains intentional.

Final live scan: 0 FAIL with the declared few-pictures allowance, no-footage warning
only. All seven final live screenshots were opened and visually checked.

## SEO and agent discovery — 21 October 2026

Added descriptive title/description metadata; linked WebSite, WebPage and
MobileApplication JSON-LD; a 1200 × 630 sharing card made from approved brand assets
and the current app capture; and four visible, factual questions and answers.
The plain headline requested by the user remains unchanged. Added robots guidance,
canonical sitemap lastmod, /llms.txt, /index.md and HTML/HTTP discovery links.
No prices, reviews, ratings or downloads were invented. SEO.md records the
maintenance rules, primary references and indexing limitations.

The initial questions layout was replaced with always-visible answers after the
browser pass: this improves reading and crawler access and eliminates unnecessary
accordion interaction. Final local taste scan under actual handler headers:
0 FAIL with the existing few-pictures allowance, no-footage warning only.
All seven generated viewport sheets and the three questions captures were opened.
Eight handler/discovery tests, root lint/typecheck, JavaScript syntax and whitespace
checks pass. Twelve-width browser checks include visible questions, JSON-LD parsing,
stable feature switching, keyboard navigation, no-script content, no overflow and
no JS exceptions. No new visual score is assigned to this SEO-focused pass.

SEO release deployed through AWS MCP: CloudFormation UPDATE_COMPLETE, CloudFront
Deployed, cache invalidation Completed. Artifact SHA-256:
`1fc464839338052280271a68381f97ae596af39e5366fd5f4dd69a62291f319d`.
Live HTML, CSS, JS, all screenshots, social card, llms.txt, Markdown, robots and
sitemap match local release hashes. Metadata HTTP headers and Markdown MIME type
pass. Googlebot, Bingbot, OAI-SearchBot, PerplexityBot and Claude-SearchBot user-agent
requests return HTTP 200. This is access testing, not evidence of real bot visits.
The public IndexNow ownership file was verified before submitting the homepage.

IndexNow returned HTTP 202: notification received, ownership verification pending.
Evidence: indexnow-submission.json. This is not a claim that any engine has indexed
the site. Google Search Console verification/submission was not performed.

Final live taste scan: 0 FAIL with the documented few-pictures allowance, no-footage
warning only. All seven live inspector screenshots were opened and reviewed.
Live 390/768/1440px checks pass for the feature tour, visible questions, JSON-LD
parsing, keyboard focus flow, no-script fallback, no overflow and no JS exceptions.
Public security/redirect/origin checks pass; verification.json records release
hashes. Physical-phone Safari and search rankings remain unverified.
