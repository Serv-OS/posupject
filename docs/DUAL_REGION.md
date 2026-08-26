# Trading in the UK and the US at once

posupject now runs both regions from one CRM. This is how it works and what
still needs a human hand (Twilio console + Stripe are outside the repo).

## The model

- **`support_regions`** (UK + US rows) holds everything that differs by
  region: the phone line, its hours **in its own timezone**, voice + greeting +
  voicemail wording, SMS auto-reply copy, currency, tax label and default
  rate, and the seller identity printed on documents.
- **`support_settings`** stays the global brand and the **fallback**: any
  region column left empty falls back to it, so nothing changes until a region
  is actually configured. Settings → **Regions (UK & US)** edits both rows.
- **Inbound** calls and texts pick their region by the number that was dialled
  (the Twilio `To` field). One deployed function serves every line.
- **Outbound** picks the line by the recipient's country prefix: +1 → the US
  number, everything else → UK. SMS replies on a ticket always leave from the
  line the customer used (`tickets.service_number`, stamped by the inbound
  webhooks).
- **Documents**: invoices, quotes and recurring schedules carry a `currency`
  ('GBP' | 'USD'). It defaults from the company's **Country** field, drives
  the £/$ symbol, the VAT / Sales-tax label, the default tax rate (20 / 0),
  the PDF, the email subject, the public page and the Stripe charge currency.
  The Stripe webhook refuses to reconcile a payment whose currency doesn't
  match the document — it logs loudly instead of guessing.
- **Reports** never blend currencies: Reports has a GBP/USD lens, dashboards
  show `£X + $Y` side by side, CSV exports carry a Currency column. There is
  deliberately **no invented FX conversion** anywhere.
- **Time**: each line's hours run on its own clock (a US caller at 2pm Pacific
  is inside US hours, not outside UK ones). Staff quiet hours use the
  timezone on their own profile (Account page). Recurring USD invoices are
  dated in the US day, GBP in the UK day. Contact/company/ticket screens show
  a "Their time" chip worked out from the phone number.

## Go-live checklist for the US line (Peter)

1. **Buy a +1 number** in the Twilio console (same account).
2. Point its webhooks at the SAME URLs the UK number uses:
   - Voice → `https://yuevuqvldtmjwwzjrddo.supabase.co/functions/v1/twilio-voice-incoming`
   - Messaging → `https://yuevuqvldtmjwwzjrddo.supabase.co/functions/v1/twilio-inbound-sms`
3. Paste the number (E.164, e.g. `+16505551234`) into Settings → Regions →
   United States → Twilio number. That's the whole software side — no deploy,
   no env change.
4. Set the US hours + timezone in the same card (they default to
   America/Los_Angeles, 9–5, disabled).
5. **A2P 10DLC**: US carriers will not deliver application SMS from an
   unregistered number. Register the number for A2P in Twilio (same process as
   the psc-crm saga — brand + campaign). **Voice works immediately; SMS to US
   handsets is gated on this registration.**
6. Stripe: the existing account can charge USD (converted at settlement). If
   you want USD settling into a US bank account instead, that's a Stripe
   account/settings decision — say the word and the per-region keys get built.

## Two-way website chat (shipped alongside)

When the bot raises a ticket the chat now **stays open**: the visitor keeps
typing, the team answers from the ticket's **Chat** tab, and the widget polls
every 4s for replies. The chat ends when a person ends it — the **End chat**
button, or resolving/closing the ticket (a DB trigger closes the session).
The widget then tells the customer and resets ready for a new conversation.

## Decisions taken (both reversible)

- **One invoice/quote number series** across both regions (INV-1001, INV-1002…
  regardless of currency). Legal in both; separate series per region can be
  added later but can't be applied retroactively.
- Combined reports show currencies **side by side**, never converted.
