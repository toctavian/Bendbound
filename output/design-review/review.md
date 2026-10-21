# Native design review — 20 October 2026

The Impeccable / Emil design-engineering refinement uses Taste Skill's True-black
flat app direction (seed 828309468), adapted to the existing native app and the
user's fixed logo, palette and system typography. No redraw, stock photography,
new artwork, new dependency or fabricated data was introduced.

The map and routes are the signature visual: the interface gives those more
clarity through flat surfaces, legible measurements and a distinct next action.

| Before (source inspection) | After | Why |
| --- | --- | --- |
| Heavy 800–900 weights across labels and titles | 500–700 weights, clear title / heading / body roles | Restore hierarchy and make route information easier to scan |
| Tiny uppercase ride labels | 13pt sentence-case labels and tabular values | Improve measurement readability |
| Coloured fills on competing route actions and segmented controls | One cyan primary; neutral secondary and selection fills | Make the next task clear while keeping the brand palette |
| Bespoke switch drawing; 38pt compact buttons | Native switches and minimum 44pt controls | Improve native familiarity, touch and accessible checked state |
| White text on cyan / green fills | Dark ink on all filled ActionButtons | Contrast: cyan 6.10:1, green 7.36:1, red 4.58:1 |
| A fixed synthetic activity chart on Profile | Actual recorded-ride totals and honest empty history | Avoid implying activity that was never recorded |
| Tour action below the collection | Plan a tour in the title area; instructive empty copy | Keep the main job available on arrival |
| Light status icons over a light map | Charcoal safe-area background | Keep the system status readable |
| Cached tab text clipped after changing system text size | Content remounts when fontScale changes; wrapping header | Keep accessibility text measurable and readable |

## Evidence

- Local Xcode workspace Debug / iphonesimulator build: succeeded, unsigned simulator
  app at `/tmp/bendbound-design-build/Build/Products/Debug-iphonesimulator/Bendbound.app`.
- iPhone 16 Pro (402pt wide), iOS 18.6: Map, empty Tours, Saved cards, Profile and
  standard route planner. Native controls were inspected through Device Hub.
- iPhone 16e (390pt wide), iOS 18.6: Map and round-trip form; swiped the sheet and
  visually confirmed Cancel / Create route remain reachable. Location permission
  was declined on this test simulator; no real location was requested or recorded.
- Accessibility-large text: inspected Map, empty Tours and Saved. Corrected stale
  text measurement; constrained numeric map badge scaling to its fixed cartographic
  footprint. Restored the original `large` category afterward.
- Typecheck, Expo lint and 68 relevant existing tests pass. Taste source lint:
  0 FAIL / 0 WARN. The HTML browser inspector does not verify a native app and was
  not used as native evidence.

## Limits

The original installed simulator binary lacked ExpoWebBrowser, so the initial
before-map image is an error diagnostic, not a valid visual baseline. Before/after
findings above compare the original source with native screenshots of the changes.
No before-render score or comparative measurements are claimed.

Native evidence is not proof of physical-device touch, battery, background GPS,
account lifecycle or group-sharing acceptance. Android rendering and the entire
account/group/security flows were not visually exercised. Existing app content and
sample saved tours were preserved. No account operation was performed. The stored
simulator account-recovery notice visible on Profile is existing simulator state.

Final visual assessment: hierarchy, palette preservation and touch-target layout
meet this refinement's scope. Screens remain deliberately functional; no gallery
or marketing-page aesthetics were applied. Screenshots show the native result;
there is no invented numerical design-quality score.
