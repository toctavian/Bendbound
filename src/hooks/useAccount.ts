import { useEffect, useState } from 'react';
import { accountSession } from '@/services/auth/cognito';
export function useAccount() {
  const [state, setState] = useState(accountSession.state);
  useEffect(() => accountSession.subscribe(setState), []);
  return state;
}
