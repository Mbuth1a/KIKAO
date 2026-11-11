# Kikao PWA prototype

A mobile-first, installable PWA prototype for discovering and hosting small-group plans in Nairobi.

## Run locally

1. Extract the ZIP.
2. Open a terminal in the extracted `kikao-pwa` folder.
3. Run:

   ```bash
   python -m http.server 8000
   ```

4. Open `http://localhost:8000` in Chrome, Edge or Safari.
5. Complete the demo onboarding. The prototype opens with a simulated KES 5 verification checkout.

A local HTTP server is required for the service worker and installability. Opening `index.html` directly with `file://` still displays the app, but offline/PWA features will not register.

## Included flows

- Demo onboarding: name, phone, age gate and simulated verification fee.
- Discover feed with area/text, plan-type and budget filters.
- Create a party, chill or road-trip plan.
- Host approval flow with an explicit demo request generator.
- Join request → simulated host approval → simulated KES 300 deposit → confirmed spot.
- Lobby chat, check-in/check-out, share-plan and report controls.
- Full lobby lock and waitlist state.
- Trusted-contact profile field and safety centre.
- Browser `localStorage` persistence and service-worker app-shell caching.

## Important prototype boundaries

- **No real M-Pesa integration.** The STK Push and successful payment states are simulations. Production payments need a server-side integration with a licensed provider, signed callback validation, reconciliation, refund handling and clear deposit/forfeiture terms.
- **No identity verification.** The profile badge is a demo state only. Do not treat it as evidence of a real person's identity or age.
- **No live moderation or emergency response.** Reports are stored locally in the browser. The SOS screen is informational only.
- **No real-time backend.** Plans, chat, requests and payment states are stored in this browser only. Multiple users/devices do not share data.
- **Sample plans are fictional demo records.** They are not real events or venue recommendations.
- **Legal review required.** The age gate is configurable in `app.js` (`MIN_AGE`). The current default is 18 for prototype testing only. Review current Kenyan alcohol, privacy, consumer-protection, transport and payment rules before public launch.
- **Alcohol positioning.** Kikao is a social coordination tool; it does not sell, deliver or advertise alcohol. Hosts must select lawful venues and activities. Road trips require an alcohol-free designated driver.

## Demo amounts

Edit the constants near the top of `app.js`:
- `VERIFY_FEE = 5`
- `DEFAULT_DEPOSIT = 300`
- `MIN_AGE = 18`

These are demonstration defaults, not final pricing or legal advice.

## Suggested production architecture

- PWA frontend + authenticated API.
- Backend-enforced tenant/user permissions and moderation audit trail.
- Real phone OTP and age/identity verification provider.
- Payment provider integration; never accept a client-side payment-success flag.
- Realtime lobby messaging with moderation, block/report enforcement and retention controls.
- Location minimisation: area in public feed; exact venue only for approved participants.
- Trusted-contact share links with expiry and explicit consent.
