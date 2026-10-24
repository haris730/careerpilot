# CareerPilot — Lemon Squeezy Test-Mode Audit

## Scope and current code behavior

- Checkout route: `POST /api/checkout`.
- Webhook route: `POST /api/billing/webhook`.
- Monthly checkout uses `LEMONSQUEEZY_MONTHLY_VARIANT_ID`; yearly checkout uses `LEMONSQUEEZY_YEARLY_VARIANT_ID`.
- The checkout payload does **not** set a `test_mode` field. The mode depends on whether `LEMONSQUEEZY_API_KEY` is a test-mode or live-mode key.
- The checkout stores `user_id` and `plan` in Lemon Squeezy custom data and redirects to the app at `/#profile`.
- Webhook signatures are checked using HMAC-SHA256 of the raw request body against `X-Signature`; an invalid signature returns HTTP 401.
- Current entitlement source of truth is `user_entitlements`: the Worker upserts `plan`, `premium_until`, and `updated_at` using `SUPABASE_SERVICE_ROLE_KEY`.
- **Important audit gap:** the current Worker does not update `profiles.premium`; it only updates `user_entitlements`. I did not add an unverified write to that table because the connected Supabase workspace does not expose the CareerPilot project/schema, so the profile table key/column cannot be confirmed safely. Do not mark the `profiles.premium` requirement as passed until the schema is confirmed and this is addressed. No RLS or Supabase policies were changed.
- The webhook handler uses the subscription `status` and `ends_at`/`renews_at` fields rather than an explicit event-name allowlist. Configure the subscription lifecycle events below; avoid `order_created` for entitlement state because an order event may not carry an active subscription status.

## Worker variables (names only)

- `LEMONSQUEEZY_API_KEY` — set to a **test-mode** API key during testing.
- `LEMONSQUEEZY_STORE_ID`
- `LEMONSQUEEZY_MONTHLY_VARIANT_ID`
- `LEMONSQUEEZY_YEARLY_VARIANT_ID`
- `LEMONSQUEEZY_WEBHOOK_SECRET` — must match the signing secret configured on the Lemon Squeezy webhook.
- `SUPABASE_SERVICE_ROLE_KEY` — Worker-only secret used for privileged database writes.

Never place the service-role key or webhook secret in browser code.

## Lemon Squeezy dashboard setup

1. Create/configure monthly and yearly subscription variants in the intended test store.
2. Set the Worker variables above to the test store, matching variant IDs, test-mode API key, webhook signing secret, and service-role key.
3. Create a webhook pointing to `https://careerpilot.mohammadhariscom7.workers.dev/api/billing/webhook`.
4. Select `subscription_created`, `subscription_updated`, `subscription_cancelled`, and `subscription_expired`. Do not rely on `order_created` to grant subscription access.
5. Send a test webhook and confirm the delivery returns a successful response. A wrong signature should return HTTP 401.

## Six-step manual test

1. **Login:** Sign in to CareerPilot with a dedicated test user. Open Settings → Account & Plan and confirm the account starts on Free.
2. **Start checkout:** Click Upgrade and select monthly. Repeat with yearly after the first test. The Worker should return a Lemon Squeezy checkout URL and payment should redirect back to `/#profile`. Confirm the API key is in test mode before entering payment details.
3. **Pay with test card:** Complete checkout using the test card details provided by Lemon Squeezy for the test store. Do not use a real payment card.
4. **Check database:** In Supabase, inspect that user's `user_entitlements` row. After `subscription_created`/an active `subscription_updated`, expect `plan = 'premium'` and a future `premium_until`. The code currently does not set `profiles.premium`; that requirement remains unverified/unimplemented.
5. **Refresh app:** Reload CareerPilot and open Settings → Account & Plan. The app should read the entitlement and show Premium with up to 100 AI actions/month. Check Worker logs and Lemon Squeezy webhook delivery history if the row/UI does not update.
6. **Cancel and expire:** Cancel the test subscription. If the cancellation event includes a future `ends_at`, the handler keeps Premium until that date; an expired status should set `plan = 'free'` and `premium_until = null`. Confirm the UI returns to Free after expiry. Repeat the purchase/cancel cycle with the yearly variant if possible.

## Known reliability fix in this PR

The Worker previously recorded a webhook event before updating `user_entitlements`. If the entitlement write failed, a retry could be treated as a duplicate and skipped. This PR moves event logging after the entitlement upsert so a retry can repair the entitlement state before duplicate detection.

## Troubleshooting

- **Worker logs:** look for checkout configuration errors, webhook signature failures, and entitlement update failures. Never log or share secret values.
- **Lemon Squeezy webhook delivery log:** inspect the event name, HTTP status, and response body; resend failed test events after correcting configuration.
- **Supabase:** inspect the user's `user_entitlements` row and the `billing_events` row for the matching event. The profile premium field is not updated by current code and needs schema-confirmed follow-up.
