import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { Alert, Share, StyleSheet, Text, View } from 'react-native';
import { AccountPanel } from './AccountPanel';
import { ActionButton } from './ui';
import { useAccount } from '@/hooks/useAccount';
import { accountSession, accountsAvailable } from '@/services/auth/cognito';
import { clearLobby, groupCommand, readLobby, roomClient, saveLobby } from '@/services/groups/lobby';
import type { SavedLobby } from '@/services/groups/lobby';
import { GroupRequestError, groupInviteLink } from '@/services/groups/client';
import type { GroupRoom } from '@/services/groups/client';
import { createRouteShare, loadRouteShare } from '@/utils/routeSharing';
import { motorcycles, motorcycleTypeOrDefault } from '@/data/motorcycles';
import type { DraftRoute, MotorcycleType } from '@/types';
import { colors } from '@/theme';

type Props = { route?: DraftRoute; avoidMotorways: boolean; motorcycleType: MotorcycleType; invite?: { roomId: string; token: string; routeId?: string }; onOpenRoute?: (route: DraftRoute, avoidMotorways: boolean) => void };
export function GroupRidePanel(props: Props) {
  const { account } = useAccount();
  return <GroupRidePanelContent key={account?.id ?? 'signed-out'} {...props} />;
}
function GroupRidePanelContent({ route, avoidMotorways, motorcycleType, invite, onOpenRoute }: Props) {
  const { account, logoutPending } = useAccount();
  const [room, setRoom] = useState<GroupRoom | null>(null);
  const [busy, setBusy] = useState(!!account && !!roomClient && !invite);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<SavedLobby | null>(null);
  const running = useRef(false);
  const owner = !!room?.members.some(m => m.userId === account?.id && m.role === 'owner');
  const accountId = account?.id;
  useEffect(() => {
    let cancelled = false;
    if (accountId && roomClient && !invite) {
      void readLobby().then(async value => {
        if (cancelled) return;
        setSaved(value);
        if (value?.roomId) {
          const current = await roomClient!.read(value.roomId);
          if (!cancelled) setRoom(current);
        }
      }).catch(failure => {
        if (!cancelled) {
          if (failure instanceof GroupRequestError && failure.code === 'ROOM_UNAVAILABLE') { setSaved(null); void clearLobby(); }
          else setError('Could not restore your group. Retry before creating another.');
        }
      }).finally(() => { if (!cancelled) setBusy(false); });
    }
    return () => { cancelled = true; };
  }, [accountId, invite]);
  const run = async (operation: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not update your group.'); }
    finally { running.current = false; setBusy(false); }
  };
  const requireAccount = () => {
    const current = accountSession.state().account;
    if (!current || current.id !== account?.id || !roomClient) throw new Error('Sign in to use your group.');
    if (current.displayName === 'Rider') throw new Error('Save your rider name above first.');
    return current;
  };
  const sendInvite = () => run(async () => {
    const current = requireAccount();
    let value = saved ?? await readLobby();
    if (!value) {
      if (!route) throw new Error('Generate a route before creating a group.');
      const link = await createRouteShare(route, avoidMotorways);
      const routeId = new URL(link).pathname.split('/').pop()!;
      value = { accountId: current.id, endpoint: roomClient!.baseUrl, routeId,
        create: { command: groupCommand(), title: route.title.trim().slice(0, 80), displayName: current.displayName, motorcycleType } };
      requireAccount();
      await saveLobby(value); setSaved(value);
    }
    let active = room;
    if (!active && value.roomId) active = await roomClient!.read(value.roomId);
    if (!active) {
      if (!value.create) throw new Error('Your group could not be restored.');
      // Stable persisted command/body closes duplicate creation after a lost response.
      // After the retry window, derive and read its deterministic room ID first.
      if (Date.now() - value.create.command.createdAt > 110_000) {
        const id = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${current.id}\0${value.create.command.id}`);
        active = await roomClient!.read(id);
      } else active = await roomClient!.create(value.create);
      requireAccount();
      value = { ...value, roomId: active.id }; await saveLobby(value); setSaved(value); setRoom(active);
    }
    const result = await roomClient!.invite(active.id);
    requireAccount(); setRoom(result.room);
    const link = groupInviteLink(active.id, result.token, value.routeId);
    await Share.share({ message: `Join my Bendbound ride: ${active.title}\n${link}\nOpen on an iPhone with Bendbound installed. Invite expires ${new Date(result.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` });
  });
  const join = () => run(async () => {
    const current = requireAccount();
    if (!invite) return;
    const existing = await readLobby();
    if (existing?.roomId && existing.roomId !== invite.roomId) throw new Error('Leave or end your current group from the map before joining another.');
    const active = await roomClient!.join(invite.roomId, invite.token, current.displayName, motorcycleType);
    requireAccount();
    await saveLobby({ accountId: current.id, roomId: active.id, routeId: invite.routeId });
    setRoom(active);
  });
  const refresh = () => run(async () => {
    requireAccount();
    const id = room?.id ?? saved?.roomId;
    if (!id) { const value = await readLobby(); setSaved(value); if (value?.roomId) setRoom(await roomClient!.read(value.roomId)); return; }
    const currentRoom = await roomClient!.read(id); requireAccount(); setRoom(currentRoom);
  });
  const closeGroup = () => run(async () => {
    requireAccount(); if (!room) return;
    if (owner) await roomClient!.end(room.id, groupCommand()); else await roomClient!.leave(room.id, groupCommand());
    await clearLobby(); setRoom(null); setSaved(null);
  });
  return <View style={styles.panel}>
    <Text style={styles.title}>Group ride</Text>
    <Text style={styles.copy}>{room?.title ?? route?.title ?? 'Join your riding group'}</Text>
    <AccountPanel compact />
    {!accountsAvailable ? <Text style={styles.copy}>Account access is not enabled in this build.</Text> : null}
    {account && !logoutPending ? <>
      {!roomClient ? <Text style={styles.copy}>Group invitations are not connected in this build yet.</Text> : <>
        {room ? <>
          <Text style={styles.heading}>{room.members.length} / 10 riders · {owner ? 'You are the host' : 'Member'}</Text>
          {room.members.map(member => <View key={member.userId} style={styles.member}>
            <Text style={styles.heading}>{member.displayName}{member.userId === account.id ? ' (you)' : ''}</Text>
            <Text style={styles.copy}>{member.role === 'owner' ? 'Host · ' : ''}{motorcycles[motorcycleTypeOrDefault(member.motorcycleType)].label}</Text>
          </View>)}
          <ActionButton label="Refresh riders" icon="refresh-outline" loading={busy} onPress={refresh} />
          <ActionButton label="Update my rider details" disabled={busy} onPress={() => run(async () => { const current = requireAccount(); setRoom(await roomClient!.profile(room.id, groupCommand(), current.displayName, motorcycleType)); })} />
          {owner ? <ActionButton label="Send invite" icon="person-add-outline" loading={busy} onPress={sendInvite} /> : null}
          {(saved?.routeId || invite?.routeId) && onOpenRoute ? <ActionButton label="Open invited route" icon="map-outline" loading={busy} onPress={() => run(async () => { const shared = await loadRouteShare(saved?.routeId ?? invite?.routeId); onOpenRoute(shared.route, shared.avoidMotorways); })} /> : null}
          <ActionButton label={owner ? 'End group' : 'Leave group'} disabled={busy} onPress={() => Alert.alert(owner ? 'End this group?' : 'Leave this group?', owner ? 'This closes the group and its invitation for everyone.' : 'You will need a fresh invitation to rejoin.', [{ text: 'Cancel', style: 'cancel' }, { text: owner ? 'End group' : 'Leave', style: 'destructive', onPress: closeGroup }])} />
          {owner ? <Text style={styles.copy}>Sending a new invite replaces the previous invite. Invited riders also need an approved pilot account.</Text> : null}
        </> : invite ? <ActionButton label="Join group" icon="people-outline" loading={busy} onPress={join} />
          : <ActionButton label="Send invite" icon="person-add-outline" loading={busy} onPress={sendInvite} />}
        {!room && !invite ? <Text style={styles.copy}>Creates a private group and shares this route with your invite. Route links are available for 90 days; group invites for up to one hour. Up to 10 approved riders.</Text> : null}
        {error ? <><Text accessibilityRole="alert" style={styles.error}>{error}</Text><ActionButton label="Retry group lookup" disabled={busy} onPress={refresh} /></> : null}
      </>}
      <Text style={styles.copy}>Live rider locations are not enabled yet. Each rider navigates independently.</Text>
    </> : null}
  </View>;
}
const styles = StyleSheet.create({ panel: { gap: 14 }, title: { color: colors.ink, fontSize: 25, fontWeight: '800' }, heading: { color: colors.ink, fontSize: 16, fontWeight: '700' }, copy: { color: colors.muted, fontSize: 14, lineHeight: 21 }, member: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.panelAlt }, error: { color: colors.action, fontSize: 14 } });
