# Wheel lead landing (Railway)

Flow: visitor spins the wheel, enters a WhatsApp number, the lead is saved and forwarded to Google Sheets (Quiz leads Oct 2026), LeadDeus, Keitaro and Meta CAPI, then the visitor opens the WhatsApp channel.

## Deploy
1. New Railway project, "Deploy from GitHub repo" (push this folder) or `railway up` from this folder.
2. Add a Postgres database to the project and reference its `DATABASE_URL` in the service. Without it, leads go to a file that is wiped on every redeploy.
3. Set the variables from `.env.example` in the service's Variables tab.
4. Settings, Networking, Generate Domain (or add your custom domain).

## Variables
| Variable | What it does |
|---|---|
| CHANNEL_URL | WhatsApp channel the visitor is sent to after the form |
| BRAND_NAME | Name shown at the top of the page |
| GURU_NAME | Name shown on the character's speech bubbles (default `Paco, el Guru`) |
| WHEEL_SEGMENTS / WHEEL_WIN_INDEX | Wheel labels separated by `\|`, and the index (from 0) it always lands on |
| META_PIXEL_ID / META_ACCESS_TOKEN | Browser pixel plus server-side Lead via Conversions API, deduplicated by event_id |
| META_TEST_EVENT_CODE | Optional, to check CAPI in Events Manager's Test events |
| SHEETS_WEBHOOK_URL | Apps Script web app that appends the lead to the "Untitled" tab of Quiz leads Oct 2026 |
| SHEET_QUIZ_ID / SHEET_CONSENT_VERSION | Values written to quiz_id and consent_text_version, so these leads can be filtered in the sheet |
| SHEET_TIMEZONE | Timezone of the timestamp column (default Europe/Vilnius) |
| SHEETS_FORMAT | Leave empty (JSON body). Set to `form` only if the script reads `e.parameter` |
| LEADDEUS_WEBHOOK_URL / LEADDEUS_API_KEY | Where each new lead is POSTed (Bearer auth if a key is set) |
| KEITARO_POSTBACK_URL | e.g. `https://your-keitaro/xxxx/postback?subid={subid}&status=lead` |
| ADMIN_TOKEN | Enables CSV export at `/admin/leads.csv?token=...` |
| PHONE_REGEX | Optional, default Spanish mobile `^\+34[67]\d{8}$` |

## Ad link
Pass Keitaro's subid to the landing, e.g. `https://your-domain/?subid={subid}&utm_source=fb&utm_campaign=...`. The landing also reads `fbclid`, `_fbp` and `_fbc` for Meta matching.

## Notes
- Duplicate numbers are stored once and forwarded once.
- Each lead row records whether the Sheet, LeadDeus, Keitaro and CAPI calls succeeded (see the CSV and Railway logs).
- Only new numbers go to the sheet; a repeat submit of the same number is not written twice.
- LeadDeus body is built in `sendToLeadDeus()` in server.js; rename the fields there if LeadDeus expects different ones.

## The character (Paco, el Guru)
Paco is an SVG drawn inline (no image files) and talks in three places: above the wheel, after the win, and after the form. He changes mood (smirk, surprised, wink).
All his lines live in `window.LP.guruLines` at the top of `public/index.html`, including the form errors. `{prize}` and `{brand}` are replaced automatically. Keep the 18+ line and the "Los pronósticos no garantizan resultados" line in the footer.
