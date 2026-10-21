import { Redirect } from 'expo-router';
// Browser callback parameters never create a session here. AuthRequest owns
// state/PKCE validation and code exchange; this route simply avoids a missing screen.
export default function AccountCallback() { return <Redirect href="/profile" />; }
