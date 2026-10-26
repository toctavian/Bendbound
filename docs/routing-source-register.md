# Routing source register

Register prepared: **2026-10-20**. This records source evidence already present in the repository, not a new crawl or proof of current page availability.

The existing evidence file is [routing/catalogue/evidence.json](../routing/catalogue/evidence.json), with a shared **checkedAt date of 2026-10-07**. It records three pages and 18 source–road-reference associations across 15 distinct road references. There are no individual fetch timestamps, response hashes or archived extraction records for these historical entries. “Imported evidence” below means recorded and consumed by the importer; it does not claim a reproducible full-page parse.

## Existing imported evidence

| Source ID / publisher | Page | Recorded road references | Status / scope |
| --- | --- | --- | --- |
| `devitt-south-east` / Devitt | [South East biking routes](https://www.devittinsurance.com/guides/best-biking-routes/south-east/) | A272, A275, A29, A25, A248, A286, B1012, B1010, B1021, B1018, B1026, A414 | Imported evidence, checked 2026-10-07. Each reference has its own bounding rectangle in `evidence.json`; South East England only. |
| `js-south-east` / J&S Accessories | [Motorbike routes in South East England](https://jsaccessories.co.uk/blog/advice/motorbike-routes-in-south-east-england) | A272 | Imported evidence, checked 2026-10-07. Scope rectangle: west −1.35°, south 50.85°, east 0.30°, north 51.10°. |
| `wbab-south-east` / WeBuyAnyBike247 | [Top 5 motorcycle rides in the South East of England](https://webuyanybike247.com/blog/top-5-best-motorcycle-rides-in-the-south-east-of-england) | A272, A24, A25, A32, B2026 | Imported evidence, checked 2026-10-07. Each reference has its own bounding rectangle in `evidence.json`; South East England only. |

## How those entries currently affect roads

- The PostGIS importer matches the road reference exactly and requires the **entire section geometry** to be covered by its source rectangle (`ST_CoveredBy`). A road number alone is insufficient; these sources do not endorse every section of that numbered road nationwide.
- The existing manifest contains one page per publisher. The importer counts distinct **source IDs**, so future ingestion must enforce publisher-level deduplication explicitly before introducing multiple pages from one publisher. Reprinting the same recommendation is not independent corroboration.
- With `n` matching sources, the current frequency component is `1 + 4n/(n+2)`. With evidence, the section rating is `0.7 × geometry quality + 0.3 × frequency component`, bounded to 0–5. Without evidence, it remains the geometry score. These are guide mentions, not rider votes or measured satisfaction.
- A new mention is not a fixed number of points: its marginal effect depends on the previous source count and, for the first mention, the geometry quality. A low frequency component can also lower a high geometry score. An audit must record the actual before/after values and signed delta rather than assume every mention increases the score.
- `routing/catalogue/uk/rating-sources.py` preserves existing London source sections and gives newly generated UK sections `recommendationCount: 0` and `sources: []`. UK coverage expansion alone adds no website recommendations.
- Existing records retain source IDs/URLs and component scores. They do **not** contain a historical per-road, per-ingestion signed contribution ledger. Do not invent past individual deltas; any reconstructed baseline must be labelled as reconstructed.

## New discovery and parsing statuses

No additional URLs are asserted as successfully parsed by this register. Daily ingestion records must distinguish:

| Status | Meaning |
| --- | --- |
| Discovered | URL found; page content and route claims not yet verified. No rating effect. |
| Blocked / unavailable | Access refused, robots restrictions, paywall, timeout or another retrieval failure. Record the reason; no rating effect and no bypass. |
| Parsed, awaiting review | Accessible content yielded specific route evidence; extraction is stored with provenance but not approved. No published rating effect. |
| Approved / applied | Evidence passed route mapping, duplicate and weighting checks; individual road changes and publication version are recorded. |
| Rejected / duplicate | Ambiguous location, insufficient route specificity, syndicated material or repeated publisher endorsement. Record the reason; no new points. |

Discovery is not parsing; parsing is not publication. A daily target of 20 new pages must report shortfalls honestly rather than count inaccessible pages, duplicates or fabricated route evidence.

Store factual route references, geographical scope, concise original observations, timestamps and retrieval/extraction hashes where available. Do not copy articles, photographs, third-party star ratings or GPX tracks into the source register. Retain the existing map-data attribution and do not describe this small historical source set as nationwide editorial coverage.

## Daily additions

The [daily workflow](routing-daily-research.md) maintains the cumulative machine-readable
registry at `routing/.data/research/sources.jsonl`, and individual signed per-road
changes at `routing/.data/research/contributions.jsonl`. These files are generated
when the first reviewed batch has a valid national baseline; their absence today
does not imply the three historical manifest pages have been freshly parsed.

## 21 October manual catch-up — published source register

The researcher parsed20 new pages. The first independent review held the batch;
A fresh independent review approved16 source pages;4unresolved pages are retained
without points. The reviewed batch and31historical corrections were published
at16:11BST. Actual evidence is in the run status and publication receipt.
Original proposal, first held review and correction notes are preserved.

| Source | Editorial family | State |
| --- | --- | --- |
| [RAPID ROADS - B6255](https://www.rapidtraining.co.uk/blog/2023/02/21/2023-2-21-rapid-roads-b6255) | RAPID Training | Approved; published21Oct |
| [My five favourite roads in the North of England](https://www.simonweir.co.uk/post/my-five-favourite-roads-in-the-north-of-england) | Simon Weir | Approved; published21Oct |
| [Adventuring Wales - Wrexham to Brynamman](https://rideruk.com/adventuring-wales-wrexham-to-brynamman/) | Rider UK | Approved; published21Oct |
| [A great route to ride... The Circuit of Wales](https://www.ride.co.uk/articles/a-great-route-to-ride-the-circuit-of-wales) | Bauer Media Motorcycling | Approved; published21Oct |
| [Where to ride a motorbike in Northern Ireland](https://www.motorcyclesni.co.uk/where-to-ride-motorbike-northern-ireland) | Motorcycles NI | Approved; published21Oct |
| [A weekend motorcycle route through the Cairngorms and South-East Scotland](https://www.adventurebikerider.com/a-weekend-motorcycle-route-through-the-cairngorms-and-south-east-scotland/) | Adventure Bike Rider / Adventurize Ltd | Approved; published21Oct |
| [Scotland’s top-five touring roads by motorcycle](https://www.adventurebikerider.com/article/scotlands-top-five-touring-roads/) | Adventure Bike Rider / Adventurize Ltd | Approved; published21Oct |
| [8 of Britain’s most Scenic Rides](https://www.adventurebikerider.com/article/8-of-britains-most-scenic-rides/) | Adventure Bike Rider / Adventurize Ltd | Approved; published21Oct |
| [Top Ten Motorcycle Routes in Scotland](https://www.bennetts.co.uk/bikesocial/news-and-views/features/travel/motorcycle-routes-scotland) | Bennetts BikeSocial | Approved; published21Oct |
| [Top five… roads to ride in Wales](https://www.carolenash.com/news/bike-news/detail/top-five-roads-to-ride-in-wales) | Markerstudy / Carole Nash | Approved; published21Oct |
| [12 British Roads You Need To Ride in 2021](https://www.adventurebikerider.com/article/uk-roads-to-ride-in-2021/) | Adventure Bike Rider / Adventurize Ltd | Approved; published21Oct |
| [Best Motorcycle Roads in Scotland](https://www.jadomoto.com/blogs/guides/best-motorcycle-roads-scotland) | JADO Moto | Unresolved; no points |
| [Day 16, Redcastle to Carrickfergus. Scenic Route through Cushendun: Exploring the North Coast’s Coastal Beauty](https://woodendwanderer.com/2024/08/08/day-16-redcastle-to-carrickfergus-scenic-route-through-cushendun-exploring-the-north-coasts-coastal-beauty/) | Woodend Wanderer | Approved; published21Oct |
| [RAPID ROADS - A268 (THE ROYAL MILITARY CANAL ROAD)](https://www.rapidtraining.co.uk/blog/2022/11/04/2022-11-4-rapid-roads-a268-the-royal-military-canal-road) | RAPID Training | Unresolved; no points |
| [Black Mountain Pass (A4069)](https://www.welshbikers.co.uk/routes/black-mountain-pass.html) | Welsh Bikers | Unresolved; no points |
| [Conquering the Dragon: The Essential Motorcycle Ride Routes of South Wales](https://mallorymotorcycles.com/conquering-the-dragon-the-essential-motorcycle-ride-routes-of-south-wales/) | Mallory Motorcycles | Unresolved; no points |
| [Bridgend](https://www.ride.co.uk/routes-content/bridgend) | Bauer Media Motorcycling | Approved; published21Oct |
| [Top ten motorcycle riding routes in the UK](https://www.bennetts.co.uk/bikesocial/news-and-views/features/travel/what-are-the-best-motorcycle-routes-in-the-uk) | Bennetts BikeSocial | Approved; published21Oct |
| [RAPID ROADS - B3081](https://www.rapidtraining.co.uk/blog/2022/12/01/2022-12-1-rapid-roads-b3081) | RAPID Training | Approved; published21Oct |
| [Llangollen](https://www.ride.co.uk/routes-content/llangollen) | Bauer Media Motorcycling | Approved; published21Oct |

The processed-page registry is `routing/.data/research/processed-pages.jsonl`.
It prevents held/unmapped URLs being counted as new again. Only the reviewed
ledger records applied observations and their exact signed per-road deltas.

## 22 October — supported subset published

20 new pages parsed at the scheduled 06:00 run. One independent reviewer supported
13 source pages/observations; four pages had no safe native mapping and three
observations were withheld. The supported subset published at 10:51 BST under the
user-approved standing policy, without a second review. Original source notes,
reasons and signed per-road deltas are retained in the run and cumulative ledger.

| Source | Editorial family | State |
| --- | --- | --- |
| [Best Motorcycle Roads in England and Wales](https://www.jadomoto.com/blogs/guides/best-motorcycle-roads-england-wales) | JADO Moto | Withheld: reviewer disputed provenance or route scope |
| [The ten best biking roads in Scotland](https://www.simonweir.co.uk/post/the-ten-best-biking-roads-in-scotland) | Simon Weir | Supported; published 22 Oct |
| [A Four-Day Motorcycle Tour of Wales](https://avantmotodesign.com/blogs/news/four-days-through-wales-a-motorcycle-tour-on-two-triumphs) | Avant Moto Design | Supported; published 22 Oct |
| [Five of the best motorcycle routes in the UK](https://www.rac.co.uk/drive/travel/motorbike-routes/best-motorcycle-routes-UK/) | RAC | Supported; published 22 Oct |
| [Visor Down: Motorcycling around Ards and North Down](https://www.visitardsandnorthdown.com/explore/itineraries/driving-routes-through-ards-and-north-down/visor-down-motorcycling-around-ards-and-north-down) | Ards and North Down Borough Council / Visit Ards and North Down | Supported; published 22 Oct |
| [Peak District Loop (Cat & Fiddle and Snake Pass)](https://rigsville.com/peak-district-loop-cat-fiddle-and-snake-pass/) | RigsVille | Supported; published 22 Oct |
| [B1190 – Bardney to Horncastle](https://rigsville.com/b1190-bardney-to-horncastle/) | RigsVille | Supported; published 22 Oct |
| [Top five… roads to ride in Scotland](https://www.carolenash.com/news/bike-news/detail/top-five-roads-to-ride-in-scotland) | Markerstudy / Carole Nash | Supported; published 22 Oct |
| [B1257 – Helmsley TT (Helmsley to Clay Bank)](https://rigsville.com/b1257-helmsley-clay-bank/) | RigsVille | Supported; published 22 Oct |
| [B1176 – Grantham to Corby Glen](https://rigsville.com/grantham-corby-glen-b1176/) | RigsVille | Supported; published 22 Oct |
| [The Best Motorcycle Roads in Scotland: Top 10 Scenic Routes](https://scenic.app/the-best-motorcycle-roads-in-scotland-top-10-routes/) | Scenic | Withheld: reviewer disputed provenance or route scope |
| [The Best Motorcycle Roads in England: Top 10 Routes](https://scenic.app/the-top-10-motorcycle-routes-in-england/) | Scenic | Supported; published 22 Oct |
| [5 of the best roads in the UK](https://www.adventurebikerider.com/5-of-the-best-roads-in-the-uk/) | Adventure Bike Rider / Adventurize Ltd | Supported; published 22 Oct |
| [North West & Cumbria](https://www.adventurebikerider.com/article/north-west-cumbria/) | Adventure Bike Rider / Adventurize Ltd | Withheld: reviewer disputed provenance or route scope |
| [The best of the Yorkshire Dales by motorcycle](https://www.adventurebikerider.com/article/the-best-of-the-yorkshire-dales/) | Adventure Bike Rider / Adventurize Ltd | Supported; published 22 Oct |
| [B4246 – Blaenavon to Abergavenny](https://rigsville.com/b4246-abbergavenny-to-blaenavon/) | RigsVille | Supported; published 22 Oct |
| [The Numbers Game](https://www.simonweir.co.uk/post/the-numbers-game) | Simon Weir | Withheld: mapping unresolved |
| [A483 – Newtown to Llandrindod Wells](https://rigsville.com/a483-newtown-crossgates/) | RigsVille | Withheld: mapping unresolved |
| [Great roads of the North: Part 5](https://www.motorcyclenews.com/news/2017/august/top-6-great-north-roads-part-5/) | Bauer Media Motorcycling | Withheld: mapping unresolved |
| [Tilton on the Hill to Oakham](https://rigsville.com/tilton-on-the-hill-to-oakham/) | RigsVille | Withheld: mapping unresolved |
