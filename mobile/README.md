# Real Sandbox – technician phone app

Expo (React Native) app for Android and iPhone. Works with no signal: every action is checked on
the phone with the same rules as the server (`../server/src/core`), saved on the phone, and sent in
order when there is signal.

## Try it

1. On the laptop, in this folder: `npm install`, then `npx expo start`.
2. On the phone, install **Expo Go**, scan the QR code shown on the laptop (same Wi-Fi).
3. Tap **Try the demo** – made-up jobs, nothing is sent anywhere.

To use a real server, type its address on the sign-in screen (e.g. `https://jobs.zsp.co.za`).

## Checks

- `npm run typecheck`
- `npm test` (outbox: offline queue, order, refusals)
