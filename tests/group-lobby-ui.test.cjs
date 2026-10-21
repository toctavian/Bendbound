const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript');
const roomId = 'a'.repeat(64), inviteToken = 'b'.repeat(43), routeId = 'c'.repeat(32);
function harness(account) {
  const state = []; let slot = 0, saved = null; const calls = [];
  const room = { id: roomId, title: 'Coastal ride', members: [{ userId: 'verified-user', role: 'owner', displayName: 'Octavian', motorcycleType: 'sports' }] };
  const jsx = (type, props) => ({ type, props });
  const mocks = {
    react: { useEffect() {}, useRef: v => ({ current: v }), useState: initial => { const i = slot++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], v => { state[i] = v; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Alert: {}, Share: { share: async value => { calls.push(['share', value]); } }, StyleSheet: { create: x => x }, Text: 'Text', View: 'View' },
    'expo-crypto': {}, './AccountPanel': { AccountPanel: 'AccountPanel' }, './ui': { ActionButton: 'ActionButton' },
    '@/hooks/useAccount': { useAccount: () => ({ account, logoutPending: false }) },
    '@/services/auth/cognito': { accountSession: { state: () => ({ account }) }, accountsAvailable: true },
    '@/services/groups/lobby': {
      groupCommand: () => ({ id: '00000000-0000-4000-8000-000000000001', createdAt: Date.now() }),
      readLobby: async () => saved, saveLobby: async value => { saved = value; }, clearLobby: async () => { saved = null; },
      roomClient: { baseUrl: 'https://groups.test', create: async value => { calls.push(['create', value]); return room; }, invite: async id => { calls.push(['invite', id]); return { room, token: inviteToken, expiresAt: Date.now() + 60000 }; }, read: async () => room },
    },
    '@/services/groups/client': { GroupRequestError: class extends Error {}, groupInviteLink: (id, token, route) => `bendbound://group/${id}#invite=${token}&route=${route}` },
    '@/utils/routeSharing': { createRouteShare: async (route) => { calls.push(['route', route]); return `https://route.test/shared/${routeId}`; } },
    '@/data/motorcycles': { motorcycles: { sports: { label: 'Sports' } }, motorcycleTypeOrDefault: () => 'sports' },
    '@/theme': { colors: {} },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync('src/components/GroupRidePanel.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { if (!(name in mocks)) throw new Error(name); return mocks[name]; }, module, module.exports);
  const render = () => { slot = 0; const wrapper = module.exports.GroupRidePanel({ route: { title: 'Coastal ride' }, avoidMotorways: true, motorcycleType: 'sports' }); return wrapper.type(wrapper.props); };
  return { render, calls, get saved() { return saved; } };
}
const find = (node, label) => { if (!node || typeof node !== 'object') return null; if (node.props?.label === label) return node; for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, label); if (found) return found; } return null; };
test('signed-out route group entry exposes account sign-in and no invitation action', () => {
  const h = harness(null);
  assert.equal(find(h.render(), 'Send invite'), null);
  assert.deepEqual(h.calls, []);
});
test('send invite creates one real lobby with chosen name and motorcycle, then shares route invitation; reopening exposes member controls', async () => {
  const h = harness({ id: 'verified-user', displayName: 'Octavian' });
  await find(h.render(), 'Send invite').props.onPress();
  assert.equal(h.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(h.calls.find(c => c[0] === 'create')[1].displayName, 'Octavian');
  assert.equal(h.calls.find(c => c[0] === 'create')[1].motorcycleType, 'sports');
  assert.match(h.calls.find(c => c[0] === 'share')[1].message, /bendbound:\/\/group\/.*#invite=.*&route=/);
  assert.equal(h.saved.roomId, roomId);
  const view = h.render(); assert.ok(find(view, 'Refresh riders')); assert.ok(find(view, 'End group'));
  await find(view, 'Send invite').props.onPress();
  assert.equal(h.calls.filter(c => c[0] === 'create').length, 1);
});
test('fallback Rider must be replaced before group creation or sharing', async () => {
  const h = harness({ id: 'verified-user', displayName: 'Rider' });
  await find(h.render(), 'Send invite').props.onPress();
  assert.deepEqual(h.calls, []);
});
