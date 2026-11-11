# Legacy presentation rules
- Engine feedback observes existing visible result boxes and adds focus/scroll emphasis outside document frames; original handlers, result visibility and charge state remain authoritative. Why: completion must be noticeable without changing engine execution or financial behavior.
- Engine upload accessibility uses a keyboard-only adapter for existing and dynamically rendered file labels; preserve original upload/change handlers, disabled controls and document frames. Why: keyboard access must not alter engine execution or generated output.
- Customer recovery keeps failed pagination on the same page and unsent chat until server acknowledgment; preserve delivery gates and API payloads. Why: retries must not skip records or discard work.
- Sidebar presentation must keep the existing mobile breakpoint and version every stylesheet reference. Why: desktop navigation must not cover mobile content or remain stale in immutable caches.
- Manual checkout normalizes field schemas before review, enables review only after initialization, and scopes drafts to the authenticated account and service. Why: malformed forms must not proceed and shared browsers must not expose another applicant's draft.
- Customer order lists and counts filter manual services without engine IDs before pagination; engine-backed ledger rows become engine history while stored document URLs and admin/charging routes stay unchanged. Why: instant services must not appear as waiting customer orders or lose existing downloads.
- Account emails share an inline-styled table shell and escape dynamic values while preserving existing SMTP and token flows. Why: email compatibility must not replace production authentication.
- Recharge approval entry points take the same global transaction advisory lock before row locks and check globally credited references; submissions serialize user/reference checks and reuse matching pending Auto rows. Why: one real payment must credit once without orphan retry requests.

- Admin voice alerts use null counter baselines, serialized reusable audio and explicit gesture recovery; retain mute choice and original APIs. Why: first events after zero must notify without overlapping voice or bypassing browser autoplay rules.

- Banner templates share a versioned scoped theme in dashboard and sandboxed previews; thumbnails scale the full layout rather than changing its typography, and action errors retain input until acknowledgment. Decorative motion stays on marks and accents, never copy, and respects reduced motion. Why: preview and production must match without clipping, leaking styles or reducing readability.
- Banner carousels cancel completed animation effects, serialize transitions and dispose previous timers/listeners on reload. Why: outgoing fill must never keep later banners invisible or let stale transitions overwrite current content.

- Reusable promotions use additive campaign fields and redemption rows; personal recharge coupons retain their existing redemption path. Lock users before campaigns, revalidate expiry/limits inside payment transactions, and store only the paid order price for refunds. Customer confirmation carries the reviewed payable and rejects price changes before payment; claim replays must match the original service and code. Why: concurrent campaigns must not double-credit or refund discounts as cash.
- Engine promotions claim expiring service-locked credit through the existing payment helper, while manual checkout discounts the authoritative effective price atomically; shared client countdowns follow server time and invalidate expired checkout quotes. Retain a pending claim and its idempotency key after response loss until retry or code edit. Why: engine outputs stay unchanged, timers never authorize payment, and exhausted campaigns cannot block recovery of a committed claim.

- Admin status pipelines retain each acknowledged step across all order caches and reconcile on HTTP or connection failure; delivery upload restores retry controls without discarding files or assuming ambiguous requests failed. Why: partial progress and lost responses must not trigger stale transitions or trap operators.

- File-and-deliver retries reuse acknowledged uploads scoped to the exact order and file, serialize clicks and read current order status before advancing; unreadable upload responses never authorize completion. Why: retrying a status failure must not duplicate customer files or infer success.

- Authenticated claim replays are resolved under the existing user lock before current service eligibility checks; new claims still validate service and access. Why: closing a service cannot hide a claim already committed for the same account, service and code.

- Refunded scoped credit never inherits an expiring campaign row; restore only non-expiring rows and put remainder in permanent service-scoped refund rows. Why: later campaign expiry cannot erase refunded value or widen it to wallet balance.

- Redemption rows snapshot normalized code and expiry at claim creation; migration backfills only from surviving coupons, and replay falls back to live fields solely for unsnapshotted legacy rows. Why: deleting or editing a campaign must not erase committed claim identity or weaken service/code conflict checks.
