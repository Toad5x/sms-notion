# sms-notion

Text a Twilio number from a basic phone; a Cloudflare Worker writes todos and reminders to Notion and texts reminders back when due.

## Texting

| You text | What happens |
|---|---|
| `todo buy milk` or `t buy milk` | Added to Personal Tasks (Not started, Area: Personal) instantly (no Claude) |
| `r 3pm call dentist` | Reminder today 3pm (tomorrow if already past) |
| `r tomorrow 9am pay rent` | Reminder tomorrow 9am |
| `r in 30m check oven` | Reminder in 30 minutes (`m`, `h`, `d`) |
| `r 1530 call mom` / `r 15:30 ...` | 24-hour (military) time |
| `r 3 call mom` | Ambiguous (1-11 with no am/pm): replies asking for am/pm, saves nothing |
| anything else | Claude interprets it and calls the todo/reminder tools (needs `ANTHROPIC_API_KEY`; otherwise a help message is returned) |

Only `ALLOWED_NUMBER` is answered. Other senders are ignored and unsigned requests get 403.

## Setup

1. `npm install`
2. Notion: create an internal integration at notion.so/profile/integrations, then share the **Personal Tasks** and **SMS Reminders** databases with it (••• menu > Connections).
3. Secrets (each command prompts for the value):
   ```
   npx wrangler secret put TWILIO_ACCOUNT_SID
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put TWILIO_NUMBER     # the Twilio number, +1XXXXXXXXXX
   npx wrangler secret put ALLOWED_NUMBER    # your phone, +1601XXXXXXX
   npx wrangler secret put NOTION_TOKEN
   ```
4. `npm run deploy`, then in the Twilio console set the number's "A message comes in" webhook to `POST https://sms-notion.<your-subdomain>.workers.dev/` .
5. Optional, later: `npx wrangler secret put ANTHROPIC_API_KEY` enables the free-form Claude path. Without it, unrecognized texts get a short help message.
6. Optional: enable the KV block in `wrangler.toml` for short-term conversation memory.

Timezone and model are set in `wrangler.toml`.
