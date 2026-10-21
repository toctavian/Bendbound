import { useEffect } from 'react';
import { AppState } from 'react-native';
import { accountsAvailable, retryPendingAccountSignOut } from '@/services/auth/cognito';
/** Retry protected pending logout on launch/foreground without restoring login. */
export function useAccountSignOutRecovery() {
  useEffect(() => {
    if (!accountsAvailable) return;
    const retry = () => { void retryPendingAccountSignOut().catch(() => { /* Keep pending intent; UI offers manual retry. */ }); };
    retry();
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') retry(); });
    return () => subscription.remove();
  }, []);
}
