'use strict';
const features = {
  plan: { title: 'A destination. Or a round trip.', copy: 'Add your stops or choose a distance and direction. Pick fast, winding or twisty roads, with motorway avoidance when you want it.', image: '/assets/planner.webp', alt: 'Bendbound round-trip controls for route preference, heading and motorway avoidance', caption: 'Make the route your own.' },
  record: { title: 'No plan? Just ride.', copy: 'Start a recording from the map. Bendbound keeps your GPS trail, distance and riding time, so you can save the ride you actually took.', image: '/assets/map.webp', alt: 'The Bendbound map with a Just ride recording control', caption: 'A record of the road you actually rode.' },
  save: { title: 'A road worth returning to.', copy: 'Keep planned routes in Saved and recorded rides in My tours. Bring routes in as GPX files, or export your recorded tracks.', image: '/assets/tours.webp', alt: 'Bendbound saved tours showing example routes in Triglav national park and the Surrey Hills', caption: 'Your next ride might be one you already know.' }
};
const tabs = Array.from(document.querySelectorAll('[data-feature]'));
const panel = document.getElementById('feature-panel');
const image = document.getElementById('feature-image');
function selectFeature(tab) {
  const feature = features[tab.dataset.feature];
  if (!feature) return;
  tabs.forEach(item => { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
  panel.setAttribute('aria-labelledby', tab.id);
  document.getElementById('feature-title').textContent = feature.title;
  document.getElementById('feature-copy').textContent = feature.copy;
  document.getElementById('feature-caption').textContent = feature.caption;
  image.src = feature.image; image.alt = feature.alt;
  image.classList.remove('feature-image-swap');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    requestAnimationFrame(() => image.classList.add('feature-image-swap'));
  }
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectFeature(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault(); tabs[next].focus(); selectFeature(tabs[next]);
  });
});
