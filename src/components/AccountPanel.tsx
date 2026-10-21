import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { accountsAvailable, accountSession, restoreAccountSession, signInWithApple, updateAccountDisplayName } from '@/services/auth/cognito';
import { nativeAppleClient, PilotApprovalRequiredError } from '@/services/auth/nativeApple';
import type { SessionStatus } from '@/services/auth/sessionManager';
import { colors } from '@/theme';
import { deletionClient, readDeletionReceipt, requestAccountDeletion, checkAccountDeletion, dismissDeletedAccountReceipt, RecentSignInRequiredError } from '@/services/auth/accountDeletion';
import type { DeletionStatus } from '@/services/auth/accountDeletion';

/** Private pilot until signed-device account lifecycle evidence is complete. */
export function AccountPanel({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<SessionStatus>(accountSession.state);
  const [name, setName] = useState(accountSession.state().account?.displayName === 'Rider' ? '' : accountSession.state().account?.displayName ?? '');
  const [editingName, setEditingName] = useState(false);
  const [approvalReference, setApprovalReference] = useState<string | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionStatus, setDeletionStatus] = useState<DeletionStatus | null>(null);
  const [busy, setBusy] = useState(accountsAvailable);
  useEffect(() => {
    if (!accountsAvailable) return;
    void AppleAuthentication.isAvailableAsync().then(setNativeAvailable).catch(() => setNativeAvailable(false));
    void readDeletionReceipt().then(async (receipt) => {
      setDeletionPending(receipt !== null);
      if (receipt) setDeletionStatus(await checkAccountDeletion());
    }).catch(() => { setDeletionPending(true); });
    const unsubscribe = accountSession.subscribe(setState);
    void restoreAccountSession().catch(() => {
      // Retain protected credentials on connectivity failure. No token/error logging.
    }).finally(() => setBusy(false));
    return unsubscribe;
  }, []);
  if (!accountsAvailable) return null;
  const signIn = async () => {
    setBusy(true);
    try { if (await signInWithApple()) setApprovalReference(null); }
    catch (error) {
      if (error instanceof PilotApprovalRequiredError) {
        setApprovalReference(error.requestId);
        Alert.alert('Pilot approval needed', 'Copy the request reference below and send it to the pilot organiser. After approval, sign in with Apple again.');
      } else Alert.alert('Sign-in unavailable', 'Please check your connection and try again.');
    }
    finally { setBusy(false); }
  };
  const saveName = async () => {
    setBusy(true);
    try { await updateAccountDisplayName(name); setEditingName(false); }
    catch { Alert.alert('Name not saved', 'Enter your name and try again.'); }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      const result = await accountSession.signOut();
      if (!result.providerRevoked) Alert.alert('Signed out on this device', 'Remote sign-out is still pending. Keep this app installed and retry when you have a connection.');
    } catch {
      Alert.alert('Sign-out incomplete', 'Sign-out could not be saved or completed. Please retry before closing the app.');
    } finally { setBusy(false); }
  };
  const refreshDeletion = async () => {
    setBusy(true);
    try { setDeletionStatus(await checkAccountDeletion()); }
    catch { Alert.alert('Deletion status unavailable', 'Keep this app installed and retry when you have a connection.'); }
    finally { setBusy(false); }
  };
  const deleteAccount = async () => {
    setBusy(true);
    try {
      await requestAccountDeletion();
      setDeletionPending(true);
      setDeletionStatus(await checkAccountDeletion());
    } catch (error) {
      if (error instanceof RecentSignInRequiredError) Alert.alert('Sign in again', 'For account security, sign out and sign in with Apple again, then retry deletion.');
      else Alert.alert('Deletion unconfirmed', 'The request or its response could not be confirmed. Check deletion status or retry. Your saved tours and recordings remain on this device.');
      void readDeletionReceipt().then((r) => setDeletionPending(r !== null)).catch(() => setDeletionPending(true));
    } finally { setBusy(false); }
  };
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{compact ? 'Ride together' : 'Group ride account'}</Text>
      <Text style={styles.copy}>{state.logoutPending ? 'Sign-out is unfinished. Retry to revoke your remote session; group access stays off on this device.' : state.account ? `Signed in as ${state.account.displayName}` : 'Sign in to use your account across group rides. Your saved tours stay on this device.'}</Text>
      {state.account && (editingName || state.account.displayName === 'Rider') ? <View style={styles.approval}>
        <Text style={styles.copy}>Your rider name{state.account.displayName === 'Rider' ? ' · Apple has not supplied a name for this account.' : ''}</Text>
        <TextInput accessibilityLabel="Your rider name" value={name} onChangeText={setName} maxLength={80} autoCapitalize="words" placeholder="Your name" placeholderTextColor={colors.muted} style={styles.nameInput} />
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void saveName(); }} style={styles.button}><Text style={styles.buttonText}>Save name</Text></Pressable>
      </View> : state.account && !compact ? <Pressable accessibilityRole="button" onPress={() => { setName(state.account?.displayName ?? ''); setEditingName(true); }}><Text style={styles.copy}>Edit rider name</Text></Pressable> : null}
      {!state.account && approvalReference ? (
        <View style={styles.approval}>
          <Text style={styles.copy}>Pilot approval is pending. Select and copy this reference to share with the organiser.</Text>
          <Text selectable accessibilityLabel="Pilot approval request reference" style={styles.reference}>{approvalReference}</Text>
        </View>
      ) : null}
      {deletionPending ? <View style={styles.approval}>
        <Text style={styles.copy}>{deletionStatus?.appDataDeleted
          ? deletionStatus.provider === 'drained' ? 'Your group profile, sessions and shared map data have been deleted and stored Apple tokens have been revoked.'
            : deletionStatus.provider === 'manual' ? 'Your group profile, sessions and shared map data have been deleted. Also remove Bendbound from Sign in with Apple in your Apple Account settings; automatic revocation could not be confirmed.'
              : 'Your group profile, sessions and shared map data have been deleted. Apple authorization cleanup is still pending.'
          : deletionStatus?.delayed ? 'Account deletion needs attention. Access stays blocked; contact the pilot organiser.'
            : 'Account deletion is pending or awaiting confirmation. It normally takes several minutes. Saved tours, recordings and settings stay on this device.'}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void refreshDeletion(); }} style={styles.button}><Text style={styles.buttonText}>Check deletion status</Text></Pressable>
        {deletionStatus?.appDataDeleted && ['manual', 'drained'].includes(deletionStatus.provider) ?
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void dismissDeletedAccountReceipt().then(() => { setDeletionPending(false); setDeletionStatus(null); }).catch(() => Alert.alert('Please retry', 'Deletion status could not be confirmed.')); }} style={styles.button}><Text style={styles.buttonText}>Dismiss receipt</Text></Pressable> : null}
      </View> : null}
      {!compact && state.account && deletionClient ? <Pressable accessibilityRole="button" disabled={busy}
        onPress={() => Alert.alert('Delete group account?', 'This permanently removes your group profile, sessions and shared map data. Minimal security and deletion records are retained. Your saved tours, local recordings and settings stay on this device.', [
          { text: 'Cancel', style: 'cancel' }, { text: deletionPending ? 'Retry deletion' : 'Delete account', style: 'destructive', onPress: () => { void deleteAccount(); } },
        ])} style={styles.button}><Text style={styles.buttonText}>{deletionPending ? 'Retry account deletion' : 'Delete group account'}</Text></Pressable> : null}
      {busy ? <ActivityIndicator accessibilityLabel="Updating account" color={colors.ink} /> : null}
      {state.account && compact && !state.logoutPending ? null : state.account || state.logoutPending ? (
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
          onPress={() => { void signOut(); }} style={[styles.button, busy && styles.disabled]}>
          <Text style={styles.buttonText}>{state.logoutPending ? 'Retry sign-out' : 'Sign out'}</Text>
        </Pressable>
      ) : nativeAvailable && nativeAppleClient ? (
        <View pointerEvents={busy ? 'none' : 'auto'} accessibilityState={{ disabled: busy }} style={busy && styles.disabled}>
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={6} style={styles.appleButton} onPress={() => { if (!busy) void signIn(); }} />
        </View>
      ) : <Text style={styles.copy}>Apple sign-in is not available in this build yet.</Text>}
    </View>
  );
}
const styles = StyleSheet.create({
  nameInput: { color: colors.ink, backgroundColor: colors.canvas, borderRadius: 6, padding: 12, minHeight: 48 },
  panel: { backgroundColor: colors.panel, borderRadius: 7, padding: 14, marginTop: 18, gap: 12 },
  title: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  button: { minHeight: 48, borderRadius: 6, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, flexDirection: 'row', gap: 8 },
  buttonText: { color: colors.canvas, fontSize: 16, fontWeight: '700' },
  approval: { gap: 8 },
  reference: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  appleButton: { width: '100%', height: 48 },
  disabled: { opacity: 0.5 },
});
