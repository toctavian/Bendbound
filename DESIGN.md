# Bendbound interface

## Identity and constraints

Bendbound is a mobile motorcycle route planner and ride recorder. This is a native
Expo / React Native app, with Map, Tours and Profile as its top-level destinations.
Preserve route planning, local recordings, saved tours, settings and account flows.

Keep `assets/bendbound-logo.png` unchanged, including its wordmark and proportions.
The approved logo and app icons remain governed by `assets/BRANDING.md`.

## Visual direction

Refine the existing dark interface with flat, layered charcoal surfaces, clear
system typography and deliberate space. The real map and recorded routes are the
product's visual centre; avoid decorative charts, invented activity and ornamental
cards. Treat every screen as a task interface, rather than a marketing page.

The Taste Skill app direction is **True-black flat**, seed **828309468**. Adapt its
surface hierarchy to the existing charcoal palette and its structure to native
phone navigation. The user's existing palette and iOS conventions take precedence
over the direction's desktop shell, white primary button and font suggestions.

## Colour roles

`src/theme.ts` is the source of truth. Preserve the existing colour values:

- Canvas `#111214`; sheet / tab bar `#17181b`; panel `#1a1b1e`;
  raised or selected surface `#292b2f`.
- Main text `#f5f6f7`; secondary text `#9b9ea4`.
- Brand and route red `#ec3347`; primary action cyan `#149ed0`.
- Navigation / success green `#17b978`; warning amber `#f2aa32`.

Use neutral selection fills for segmented controls. Reserve accent fills for the
main task and recording / navigation controls. Keep the existing red active tab
indicator as a brand cue. On filled cyan, red and green ActionButtons, use dark
ink: their contrast with `#111214` is approximately 6.10, 4.58 and 7.36 respectively.
Preserve route-colour customisation and semantic warning / recording colours.

## Typography and spacing

Use the platform system face with React Native font scaling enabled. Titles are
28/700; section headings 20/600; primary body 16; secondary copy 13–14. Use sentence
case, restrained weights, and tabular figures for ride measurements. Keep numerical
units visible and allow labels to wrap instead of clipping button text.

Use 20pt page and sheet gutters, 12–16pt inside related content, and 28pt above
settings sections. Content panels use 12pt corners, controls 10pt, and map sheets
20pt top corners. Existing native maps, alerts, navigation and the approved logo
retain their own conventions.

## Controls and states

Touch targets are at least 44pt. Use native switches with the whole labelled row
acting as a single accessible switch. Show selected, checked, loading and disabled
states to assistive technology. Keep action labels visible while loading.

Give controls immediate press feedback. Existing navigation transitions remain;
no decorative motion or new motion dependencies are needed for these frequent
rider tasks. Empty collections explain how to record or save a route. Profile
statistics must come from recorded rides, including honest zero values.

## Verification

Verify the native iPhone render, smaller phone widths and enlarged text, together
with lint, typechecking and the existing navigation / recording tests. Do not use a
browser approximation as evidence of native layout, touch or device performance.
Physical-device recording and group-sharing acceptance remain separate gates.
