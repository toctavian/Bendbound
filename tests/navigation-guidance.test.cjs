const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, imports = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}

const guidance = load('src/utils/guidance.ts');
const turn = { type: 10, instruction: 'Turn right onto High Street.', beginShapeIndex: 20, endShapeIndex: 80 };
const arrival = { type: 4, instruction: 'You have arrived.', beginShapeIndex: 100, endShapeIndex: 100 };

test('targets the beginning of the upcoming turn, skips the departure, and advances after passing it', () => {
  const start = { ...turn, type: 1, beginShapeIndex: 0, endShapeIndex: 20 };
  assert.equal(guidance.upcomingManeuver([start, turn, arrival], 5), turn);
  assert.equal(guidance.upcomingManeuver([start, turn, arrival], 20), turn);
  assert.equal(guidance.upcomingManeuver([start, turn, arrival], 21), arrival);
  assert.equal(guidance.upcomingManeuver([start, turn, arrival], 101), undefined);
});

test('voice cues have advance, approach and immediate stages with speed-aware lead time', () => {
  assert.equal(guidance.voiceCue(turn, 2, 50), null);
  assert.equal(guidance.voiceCue(turn, 0.45, 50).stage, 1);
  assert.equal(guidance.voiceCue(turn, 0.1, 50).stage, 2);
  assert.equal(guidance.voiceCue(turn, 0.02, 50).text, turn.instruction);
  assert.equal(guidance.voiceCue(turn, 0.65, 130).stage, 1);
  assert.equal(guidance.voiceCue(turn, 0.65, 20), null);
  assert.equal(guidance.voiceCue(turn, NaN, 20), null);
  assert.equal(guidance.voiceCue(undefined, 0.1, 20), null);
  assert.match(guidance.voiceCue({ ...turn, spokenInstruction: 'Turn right onto the A three.' }, 0.2, 50).text, /A three/);
});

function voiceHarness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const spoken = [];
  let stops = 0;
  let stopGate;
  const react = {
    useRef: (value) => { const i = cursor++; return slots[i] ??= { current: value }; },
    useState: (value) => { cursor++; return [value, () => {}]; },
    useEffect: (effect, deps) => {
      const i = cursor++;
      const previous = slots[i];
      if (previous && deps.every((dep, n) => Object.is(dep, previous.deps[n]))) return;
      effects.push(() => {
        previous?.cleanup?.();
        slots[i] = { deps, cleanup: effect() };
      });
    },
  };
  const speech = {
    stop: () => { stops++; return stopGate ?? Promise.resolve(); },
    speak: (text) => spoken.push(text),
  };
  const { useVoiceGuidance } = load('src/hooks/useVoiceGuidance.ts', {
    react,
    'expo-speech': speech,
    '@/utils/guidance': guidance,
  });
  const defaults = { enabled: true, paused: false, gpsReady: true, offRoute: false, maneuver: turn, distanceKm: 0.45, speedKph: 50 };
  return {
    spoken,
    get stops() { return stops; },
    holdStop(promise) { stopGate = promise; },
    render(overrides = {}) {
      cursor = 0;
      effects = [];
      useVoiceGuidance({ ...defaults, ...overrides });
      effects.forEach((effect) => effect());
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('GPS updates announce each stage once, including when distance jitters backwards', async () => {
  const h = voiceHarness();
  for (const distanceKm of [0.45, 0.4, 0.44, 0.1, 0.2, 0.02, 0.01]) {
    h.render({ distanceKm });
    await flush();
  }
  assert.equal(h.spoken.length, 3);
  assert.equal(h.spoken[2], turn.instruction);
  h.unmount();
});

test('mute, pause and missing GPS suppress and stop speech', async () => {
  for (const blocked of [{ enabled: false }, { paused: true }, { gpsReady: false }]) {
    const h = voiceHarness();
    h.render(blocked);
    await flush();
    assert.equal(h.spoken.length, 0);
    h.render();
    await flush();
    assert.equal(h.spoken.length, 1);
    const stops = h.stops;
    h.render({ ...blocked, distanceKm: 0.01 });
    await flush();
    assert.equal(h.spoken.length, 1);
    assert.ok(h.stops > stops);
    h.unmount();
  }
});

test('ending the ride cancels speech waiting on the native stop operation', async () => {
  const h = voiceHarness();
  let release;
  h.holdStop(new Promise((resolve) => { release = resolve; }));
  h.render();
  await flush();
  h.unmount();
  release();
  await flush();
  assert.equal(h.spoken.length, 0);
});

test('off-route warning occurs once per departure and suppresses turn prompts', async () => {
  const h = voiceHarness();
  for (const distanceKm of [0.45, 0.1, 0.02]) {
    h.render({ offRoute: true, distanceKm });
    await flush();
  }
  assert.equal(h.spoken.length, 1);
  assert.match(h.spoken[0], /off route/);
  h.render({ distanceKm: 0.02 });
  await flush();
  assert.equal(h.spoken[1], turn.instruction);
  h.unmount();
});
