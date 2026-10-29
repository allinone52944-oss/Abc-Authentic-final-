# Direct BRN-free live-test protocol (branch note — NOT a user document)

Branch: `fix-bdris-direct-brnfree-route` (base main `530a704`).
What this proves, and only this: whether the BDRIS server accepts a
DIRECT filing that carries NO parent BRN at all (parent ubrn empty,
correct names verbatim in the final record, parents' ID-card
documents types 40/41 attached). Until this run happens, direct
BRN-free server acceptance is UNPROVEN — code and tests cannot prove
it, and nothing in this branch claims otherwise.

## Rules that must not be broken during the test

- The USER enters the phone number, sends the OTP, types the OTP,
  and submits — never the assistant, never in chat, never as a test
  step by anyone else.
- One filing, one set of true data. Do NOT change names, dates,
  addresses, or documents to make a rejection go away.
- A server rejection is an ANSWER, not a retry signal: do NOT resend
  the same rejected request, do NOT resend with blindly changed data.
  A rejected submit is never forced through.
- An unknown submit outcome (no server response, timeout) is NOT a
  rejection and NOT a success: do NOT retry, do NOT start a fresh
  application — check whether the application already exists first.
  A duplicate fresh application is the one outcome to avoid.
- Never paste identifiers back: no phone numbers, no BRNs, no dates
  of birth, no application numbers, no tokens, no OTP codes. Paste
  only error-banner text and journal lines (see below).

## User steps (in order)

1. Fill the application on the deployed engine exactly as usual
   (all brackets are in scope: pre-2013, 2013, 2014+ with no parent
   BRN, family names-only). Leave BOTH parents' BRN fields empty.
   Attach the parents' ID cards as types 40 and 41. Keep the
   applicant's own channel: this is the direct path, not the bot
   page's verified gate — do not expect a parent Verify button to
   be the decider here.
2. Reach Step 6 preview. Confirm the preview shows the parents'
   names correctly and no parent BRN (the preview itself proves
   nothing about the server — only the server answers below do).
3. Enter the phone number yourself, press Send Code, and wait for
   the SMS. Note how long it took and whether the page shows a
   sent proof — do not press send again while waiting.
4. Type the OTP yourself, press verify/submit yourself, and wait
   for the result page. Note whether the original application copy
   (Form-1 print) downloads — that is the post-submit deliverable.

## What to observe at each stage

- SEND: HTTP status + the exact wording of any error banner.
  A 200 with a non-JSON body is a session problem, not a
  rejection (the engine expects `{code: "MESSAGE_SENT",
  success: true}`). A 400 WITH wording is the server's own reason
  — copy the wording exactly. A 400 with no wording proves nothing
  by itself; the journal OTP-send lines are needed.
- VERIFY: verified or not, exactly as the page reports it. A
  verify failure must never reach submit.
- SUBMIT: success phrase + print link present, or the exact
  rejection wording/field (e.g. a parent ubrn field name). If the
  submit response names a field, that field name — not any value —
  is what gets pasted back.
- CHARGE: submit charge once (90). A retry after a failed chain
  keeps the same idempotency key: a DUPLICATE_TRANSACTION answer
  means charged 0 + token, not a double charge. Never re-charge
  blindly after an unknown outcome.

## What proves a pass

- Send returns MESSAGE_SENT/success, verify reports verified, and
  submit returns the verified success shape (success phrase, print
  link) for a filing whose payload carried parent ubrn empty.
  That — and only that — proves the direct BRN-free route.

## What proves a server rejection (and what to do)

- Any stage returns a definitive server rejection with wording
  (400/validation text). STOP at that stage. Paste back: the stage
  name, the status, the exact banner wording, and the journal
  lines for that stage. Do not retry, do not change data, do not
  fall back to the bot page expecting it to pass BRN-free — the
  bot page requires verified parent BRN and cannot pass this
  filing BRN-free.

## Open questions this run must answer (in priority order)

1. Does the server accept empty parent ubrn on direct submit?
2. Does it accept a backtick in a name in the FINAL submit record?
   (Send/verify now carry the transit, backtick-free form; the
   submit payload keeps names verbatim on purpose. If submit
   rejects on a name mark, the answer is to transit the submit
   names too — decided by this run's wording, not by guessing.)
3. Does it accept the Bengali-label-free enum relation on all
   three calls (send, verify, submit)?
4. Does the PERMANENT geoLocationId (permanent address
   LocationId) verify and submit correctly when officeAddressType
   is PERMANENT?

## What to paste back (and nothing else)

- Stage (send / verify / submit), HTTP status, exact error-banner
  text, and the matching journal lines (HTTP seed/send/verify/
  submit lines only).
- NO phone numbers, NO BRNs, NO dates of birth, NO application
  numbers, NO tokens, NO OTP codes, NO file names with numbers.
