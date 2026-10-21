import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { accountSession } from './cognito';
import { createDeletionClient } from './deletionClient';
export { RecentSignInRequiredError } from './deletionClient';
export type { DeletionStatus } from './deletionClient';
export const deletionClient = createDeletionClient(process.env.EXPO_PUBLIC_ACCOUNT_API_URL);
const KEY = 'bendbound.account.deletion.v1';
const options: SecureStore.SecureStoreOptions = { keychainService: 'com.octavian.bendbound.accounts', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
type Receipt = { version: 1; binding: string; accountId: string; receiptSecret: string };
let running = false;
export async function readDeletionReceipt(): Promise<Receipt | null> {
  if (!deletionClient) return null;
  const raw = await SecureStore.getItemAsync(KEY, options);
  if (raw === null) return null;
  const r = JSON.parse(raw) as Receipt;
  if (r.version !== 1 || r.binding !== deletionClient.baseUrl || typeof r.accountId !== 'string' || !r.accountId
    || typeof r.receiptSecret !== 'string' || !/^[a-f0-9]{64}$/.test(r.receiptSecret)) throw new Error('Deletion requires its original service configuration.');
  return r;
}
export async function requestAccountDeletion() {
  if (!deletionClient || running) throw new Error('Account deletion unavailable.');
  running = true;
  try {
    const account = accountSession.state().account;
    if (!account) throw new Error('Sign in before deleting your account.');
    const accessToken = await accountSession.accessToken();
    if (accountSession.state().account?.id !== account.id) throw new Error('Account changed; retry deletion.');
    let receipt = await readDeletionReceipt();
    if (receipt && receipt.accountId !== account.id) throw new Error('Finish checking the previous deletion first.');
    if (!receipt) {
      const bytes = await Crypto.getRandomBytesAsync(32);
      receipt = { version: 1, binding: deletionClient.baseUrl, accountId: account.id, receiptSecret: Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('') };
      // Persist before the HTTP call: a lost response must not lose status access.
      await SecureStore.setItemAsync(KEY, JSON.stringify(receipt), options);
    }
    if (accountSession.state().account?.id !== account.id) throw new Error('Account changed; retry deletion.');
    await deletionClient.start(accessToken, receipt.receiptSecret);
    if (accountSession.state().account?.id === account.id) await accountSession.signOut();
  } finally { running = false; }
}
export async function checkAccountDeletion() {
  const receipt = await readDeletionReceipt();
  return receipt && deletionClient ? deletionClient.status(receipt.receiptSecret) : null;
}
export async function dismissDeletedAccountReceipt() {
  const status = await checkAccountDeletion();
  if (!status?.appDataDeleted || !['manual', 'drained'].includes(status.provider)) throw new Error('Account deletion is still pending.');
  await SecureStore.deleteItemAsync(KEY, options);
}
