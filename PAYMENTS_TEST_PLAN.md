# CareerPilot — Lemon Squeezy Test-Mode Audit

## Scope and current code behavior

- Checkout route: `POST /api/checkout`.
- Webhook route: `POST /api/billing/webhook`.
- Monthly checkout uses `LEMONSQUEEZY_MONTHLY_VARIANT_ID`; yearly checkout uses `LEMONSQUEEZY_YEARLY_VARIANT_ID`.
- The checkout payload does **not** set a `test_mode` field. The mode depends on whether `LEMONSQUEEZY_API_KEY` is a test-mode or live-mode key.
- The checkout stores `user_id` and `plan` in Lemon Squeezy custom data and redirects to the app at `/#profile`.
- Webhook signatures are checked using HMAC-SHA256 of the raw request body against `X-Signature`; an invalid signature returns HTTP 401.
- Current entitlement source of truth is `user_entitlements`: the Worker upserts `plan`, `premium_until`, and `updated_at` using `SUPABASE_SERVICE_ROLE_KEY`.
- `user_entitlements.plan` and `user_entitlements.premium_until` are the entitlement source of truth read by the app's `ensure_my_entitlement` RPC. The flow does not rely on a `profiles.premium` column. No RLS or Supabase policies are changed by this PR.
- The handler accepts `order_created`, `subscription_created`, `subscription_updated`, `subscription_cancelled`, and `subscription_expired`. `order_created` is recorded for audit only and does not grant or revoke entitlement. Subscription events upsert the entitlement before recording the billing event, so webhook retries can repair a failed entitlement write.

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
4. Select these webhook events: `order_created`, `subscription_created`, `subscription_updated`, `subscription_cancelled`, and `subscription_expired`. `order_created` is audit-only; Premium access comes from subscription lifecycle events.
5. Send a test webhook and confirm the delivery returns a successful response. A wrong signature should return HTTP 401.

## Expected entitlement result by webhook event

| Event | Expected `user_entitlements` result |
|---|---|
| `order_created` | No entitlement change. The order event is recorded for audit only. |
| `subscription_created` | If status is `active`, `on_trial`, or `past_due` and the period end is not past: `plan = 'premium'` and `premium_until` is `ends_at`/`renews_at` or the 31-day fallback when both are absent. Otherwise: `plan = 'free'`, `premium_until = null`. |
| `subscription_updated` | Same active/status rules as `subscription_created`. A cancelled subscription remains Premium only while `ends_at`/`renews_at` is in the future. |
| `subscription_cancelled` | Keep `plan = 'premium'` until a future `ends_at`/`renews_at`; if no future paid-through date exists, set `plan = 'free'` and `premium_until = null`. |
| `subscription_expired` | Always set `plan = 'free'` and `premium_until = null`. |

The webhook upserts entitlement before writing the deduplication/audit row. A retry therefore re-applies the same entitlement state; an already-recorded event is acknowledged as a duplicate only after the entitlement upsert succeeds.

## Read-only SQL check

Run this in Supabase SQL Editor to inspect the latest entitlement rows; it does not modify data:

```sql
select user_id, plan, premium_until, updated_at
from public.user_entitlements
order by updated_at desc
limit 5;
```

## Six-step manual test

1. **Login:** Sign in to CareerPilot with a dedicated test user. Open Settings → Account & Plan and confirm the account starts on Free.
2. **Start checkout:** Click Upgrade and select monthly. Repeat with yearly after the first test. The Worker should return a Lemon Squeezy checkout URL and payment should redirect back to `/#profile`. Confirm the API key is in test mode before entering payment details.
3. **Pay with test card:** In the Lemon Squeezy test checkout, use card number `4242 4242 4242 4242`, a future expiry date, and any accepted test CVC/postal details. Use test mode only; never enter a real card.
4. **Check database:** Run the read-only SQL below and inspect the test user's row. After `subscription_created` or an active `subscription_updated`, expect `plan = 'premium'` and `premium_until` set to the provider's future `ends_at`/`renews_at` (or a 31-day fallback if both are absent). `order_created` must not change the entitlement.
5. **Refresh app:** Reload CareerPilot and open Settings → Account & Plan. The app should read the entitlement and show Premium with up to 100 AI actions/month. Check Worker logs and Lemon Squeezy webhook delivery history if the row/UI does not update.
6. **Cancel and expire:** Cancel the test subscription. If `subscription_cancelled` reports a future `ends_at` or `renews_at`, expect `plan = 'premium'` and `premium_until` equal to that end date. Once that date passes, or if no future paid-through date exists, cancellation should set `plan = 'free'` and `premium_until = null`. For `subscription_expired`, always expect `plan = 'free'` and `premium_until = null`. Repeat with the yearly variant if possible.

## Known reliability fix in this PR

The Worker previously recorded a webhook event before updating `user_entitlements`. If the entitlement write failed, a retry could be treated as a duplicate and skipped. This PR moves event logging after the entitlement upsert so a retry can repair the entitlement state before duplicate detection.

## Troubleshooting

- **Worker logs:** successful events emit `Lemon Squeezy webhook processed` with the event name and resulting plan (where applicable); duplicate deliveries that reconcile entitlement emit `Lemon Squeezy duplicate webhook reconciled`; missing/unsupported events emit `Lemon Squeezy webhook ignored`; entitlement or event-log failures emit `Lemon Squeezy entitlement update failed` or `Lemon Squeezy billing event could not be recorded`. Invalid signatures return HTTP 401 and are rejected without logging the signature or secret. Checkout errors return a structured 4xx/5xx response. Never log or share secret values.
- **Lemon Squeezy webhook delivery log:** inspect the event name, HTTP status, and response body; resend failed test events after correcting configuration.
- **Supabase:** inspect the user's `user_entitlements` row and the `billing_events` row for the matching event. The profile premium field is not updated by current code and needs schema-confirmed follow-up.
