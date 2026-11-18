# Murmur (Even Hub G2)

Sign in to Discord on your phone, tick the servers/channels (and optionally DMs) to watch, and new messages scroll by as plain text on the G2 glasses.

## Run

```bash
npm run dev                 # Vite on :5173 (bound to LAN for the phone)
npm run sim                 # desktop simulator
npx evenhub qr --url http://<your-ip>:5173   # sideload to the Even app
npm run pack                # build + package discord-feed.ehpk
```

Open with `?demo` (e.g. `npx evenhub-simulator "http://localhost:5173/?demo"`) to see fake messages without signing in.

## Glasses display

Top-right marker: `●` connected, `○` not connected, `■` paused, `▲` scrolled back in history (returns to live after 30 s without input). Messages stack from the bottom up:

```
server :: channel :: user
message
```

Each message fades out after the timeout set on the phone (Options, then "Fade messages on glasses after"; default 1 minute, or Never).

| Gesture | Action |
|---|---|
| Swipe up | History: show past messages (no fading), keep swiping for older |
| Swipe down | Newer; past the newest returns to live |
| Tap | Back to live |
| Double tap | Channel menu: channels seen in the feed (newest at the bottom), then "All channels" (while filtered), "Pause"/"Resume" and "Exit Murmur". Swipe to move, tap to choose, double tap to close |

## PluralKit

With "Condense PluralKit messages" on (default), deleted messages are removed from the feed, and servers where a proxy bot (PluralKit, Tupperbox) deletes and reposts messages are learned automatically. In those servers, messages are held for 2 s so a replaced original never shows; only the proxied repost does.

## Sign-in

Modelled on [discordo](https://github.com/ayn2op/discordo):

- **Token**: paste the `Authorization` header value from the Discord web app.
- **Email & password**: supports authenticator-app 2FA codes and backup codes. If Discord shows a captcha, use the token option.

The token is stored with the Even app's local storage on the phone. Discord's API sends CORS headers, so the WebView talks to `discord.com` and `gateway.discord.gg` directly, with no backend.

> Using a user account from a third-party client goes against Discord's Terms of Service. The risk is the same as with discordo.

## Layout

- `src/discord/api.ts`: REST (login, 2FA, guilds, channels)
- `src/discord/gateway.ts`: gateway WebSocket (heartbeat, resume, reconnect)
- `src/discord/format.ts`: message to plain text
- `src/session.ts`: session lifecycle, filters MESSAGE_CREATE into the feed
- `src/glasses.ts`: G2 display (connection dot, one fading text container per message, sized with `@evenrealities/pretext`) and input
- `src/phone.ts`: phone UI (login, channel picker, feed preview)
- `src/store.ts`: persisted config and feed

## Icon

`icon.png` (the open ring) is the store icon, set with `npx evenhub update --icon icon.png`. Other drafts are in `icons/`.
