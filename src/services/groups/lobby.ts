import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { accountSession } from '@/services/auth/cognito';
import { createRoomClient } from './client';
export const roomClient = createRoomClient(process.env.EXPO_PUBLIC_GROUP_ROOMS_API_URL, () => accountSession.accessToken());
export const groupCommand = () => ({ id: Crypto.randomUUID(), createdAt: Date.now() });
const options = { keychainService: 'com.octavian.bendbound.accounts', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const KEY = 'bendbound.group.lobby.v1';
export type SavedLobby = { accountId: string; endpoint: string; roomId?: string; routeId?: string; create?: { command: ReturnType<typeof groupCommand>; title: string; displayName: string; motorcycleType: string } };
export async function readLobby(): Promise<SavedLobby | null> {
  const raw = await SecureStore.getItemAsync(KEY, options);
  if (!raw || !roomClient) return null;
  const saved = JSON.parse(raw) as SavedLobby;
  return saved.accountId === accountSession.state().account?.id && saved.endpoint === roomClient.baseUrl ? saved : null;
}
export async function saveLobby(value: Omit<SavedLobby, 'accountId' | 'endpoint'> & { accountId?: string }) {
  const account = accountSession.state().account;
  if (!account || !roomClient || value.accountId && value.accountId !== account.id) throw new Error('Sign in to use group rides.');
  await SecureStore.setItemAsync(KEY, JSON.stringify({ ...value, accountId: account.id, endpoint: roomClient.baseUrl }), options);
}
export async function clearLobby() { await SecureStore.deleteItemAsync(KEY, options); }
