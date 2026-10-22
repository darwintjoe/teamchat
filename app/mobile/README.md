# TeamChat mobile (Expo / React Native)

Thin v0 client, the same flow as `app/web`:

1. email OTP sign-in with the code echoed on screen (CR-16) and the visible "demo build — not
   authentication" banner;
2. flat group + DM list with an unread dot (`unread.hasUnread`, two document reads);
3. open a conversation: reactive last-15 live page, on-demand older history;
4. send text;
5. send a photo (tabs: image picker → signed `pending/` PUT straight to the org bucket → confirm →
   send) — no media bytes through Convex;
6. on-demand unread count in the conversation header ("99+"), only while it is rendered;
7. offline read: the newest 100 messages per conversation are cached in AsyncStorage and readable
   from the sign-in screen or the Cache button with no network;
8. local unlock stub: PIN (hashed in the device keychain/keystore) plus an OS biometric prompt —
   a local UI gate, never authentication.

## Run

```bash
cd app/mobile
npm install
cp .env.example .env      # point EXPO_PUBLIC_CONVEX_URL at your deployment
npx expo start            # press `a` for Android, `i` for iOS, or scan the QR with Expo Go
npx tsc --noEmit          # typecheck
```

`expo-secure-store`, `expo-image-picker` and `expo-local-authentication` are included in Expo Go.

## Notes

- Tokens are stored with `expo-secure-store` (OS keychain/keystore), so the 30-day session
  survives an app restart.
- DMs are text-only in v0 (attachments are tree-group only), matching the backend contract.
- The mobile client does not send invites, create organisations, or edit messages; those stay on
  the web client where the admin surface already exists.
