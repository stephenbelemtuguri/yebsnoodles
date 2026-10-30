# Deploying YEBS Noodles on Render

Render runs the whole app as one Node web service: the Express API and the
static pages (`index.html`, `admin.html`, `driver.html`, `public/`) are served
from the same origin, so nothing else is required.

```
Browser ──► Render web service (Express) ──► Render PostgreSQL (DATABASE_URL)
                                      └──► Supabase (optional alternative)
```

`render.yaml` in the repo root is a Blueprint: Render creates the web service
**and a PostgreSQL database**, then injects `DATABASE_URL` automatically. The API
creates its `yebs_state` table on first boot, so there is no manual database key
to copy.

---

## 1. Push the code

```bash
git add .
git commit -m "Your message"
git push origin main
```

Render deploys straight from GitHub, so the repo must be up to date.

## 2. Create the Blueprint

1. Open <https://render.com/deploy?repo=https://github.com/stephenbelemtuguri/yebsnoodles>
   (one-click Blueprint) or <https://dashboard.render.com/blueprints> and choose
   **New Blueprint Instance**.
2. Connect GitHub and pick `stephenbelemtuguri/yebsnoodles`.
3. Render reads `render.yaml` and shows the `yebs-noodles` service plus the
   `yebs-db` PostgreSQL database.
4. Fill in the variables marked `sync: false` (WhatsApp, Supabase, MTN). They are
   optional — press **Apply** and the site still works without them.
5. Wait for the first deploy. The health check is `GET /api/health`.

> If you prefer a manual **New → Web Service**, use:
> **Runtime** Node, **Build** `npm install --omit=dev`, **Start** `node server.js`,
> **Health check** `/api/health`. Create a Render PostgreSQL instance and set
> `DATABASE_URL` to its internal connection string.

## 3. Environment variables

`DATABASE_URL` is injected by Render from `yebs-db`; you do **not** need to paste
a database key. Everything else is optional:

| Key | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Production behaviour |
| `ADMIN_USERNAME` | Your private administrator username | Initial administrator account |
| `ADMIN_PASSWORD` | Unique, strong password (not `goodfood@123`) | Initial administrator seed or explicitly requested reset |
| `ADMIN_CREDENTIAL_RESET_VERSION` | A unique label, only when intentionally resetting | Optional one-time reset trigger; deployment builds do not change it |
| `DATABASE_URL` | from `yebs-db` (automatic) | Orders, menu and drivers |
| `WHATSAPP_TOKEN` | Meta permanent token | Automatic order alerts |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number ID | Automatic order alerts |
| `WHATSAPP_TO` | `233559103452` | Kitchen number |
| `WHATSAPP_API_VERSION` | `v20.0` | Graph API version |
| `SUPABASE_URL` | `https://dujmpwcarxliadnfdydr.supabase.co` | Optional shared DB |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key | Optional shared DB (REST) |
| `SUPABASE_STATE_TABLE` | `yebs_state` | Optional shared DB |
| `DATABASE_POOL_URL` | Supabase session-pooler URI | Optional PostgreSQL connection; takes precedence over `DATABASE_URL` when set |
| `MOMO_SUBSCRIPTION_KEY` | MTN key | Optional automatic MoMo |
| `MOMO_API_USER` | MTN API user | Optional automatic MoMo |
| `MOMO_API_KEY` | MTN API key | Optional automatic MoMo |
| `MOMO_CALLBACK_HOST` | `https://your-service.onrender.com` | Optional automatic MoMo |
| `MOMO_TARGET_ENV` | `sandbox` or `mtnghana` | MoMo environment |
| `MOMO_PAY_TO` | `0559103452` | Wallet that receives payment |
| `MOMO_MERCHANT_NAME` | `MATHEW TIA` | Wallet account name |
| `MOMO_SMS_INGEST_TOKEN` | Random secret, at least 32 characters | Authenticates the SMS bridge |
| `MOMO_SMS_ALLOWED_SENDERS` | Comma-separated official MoMo sender IDs | Limits accepted SMS sources |
| `SENDGRID_API_KEY` | SendGrid Mail Send API key | Password recovery email |
| `SENDGRID_FROM_EMAIL` | Verified SendGrid sender address | Password recovery email |
| `SENDGRID_FROM_NAME` | `YEBS Noodles` | Password recovery email sender label |
| `SMTP_USER` / `SMTP_PASSWORD` | SMTP account credentials | Fallback recovery email |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID | Password recovery SMS |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | Password recovery SMS |
| `TWILIO_FROM_NUMBER` | Twilio-enabled sender number | Password recovery SMS |

### Recovering an existing administrator login

Admin credentials are stored in the shared database as bcrypt hashes. Change an
administrator password from **Admin Dashboard → Account Security**; the change
is persisted to the configured database and remains in effect across normal
deployments.

`ADMIN_PASSWORD` is used when seeding the first admin, migrating a legacy
default account, or applying an explicitly requested reset. Deployments do not
automatically reset credentials. To intentionally reset from Render, set
`ADMIN_USERNAME` and a new private `ADMIN_PASSWORD`, then change
`ADMIN_CREDENTIAL_RESET_VERSION` to a new unique label and deploy. The server
applies that reset once, verifies the bcrypt hash in persistent storage, and
records the label. Do not change the label again unless another reset is
intended. Never put passwords in source control, screenshots, or chat.
On the first deployment after upgrading from the former per-build reset
behavior, the old generated marker is migrated to the configured label without
changing the existing administrator password.

`GET /api/health` shows the storage mode and whether messaging providers are configured.
It returns HTTP 503 and `success: false` when persistent writes are unavailable, so
Render does not mark a deployment healthy while orders and admin changes cannot be saved:

```json
{
  "success": true,
  "storage": "postgres",
  "database": { "engine": "postgres", "persistent": true, "writable": true },
   "whatsapp": { "configured": true, "to": "233 559 103 452" },
   "recoveryDelivery": { "emailConfigured": true, "twilioConfigured": true }
}
```

Recovery tries SendGrid then SMTP for email, and Twilio then WhatsApp for
phone delivery. SendGrid requires a verified sender address. Add the actual
secret values in Render's environment settings; do not commit them.

### Optional: forward MoMo SMS from a phone

The bridge accepts HTTPS `POST /api/payments/momo/sms/ingest` requests with a
Bearer token and `{ "deviceId", "messageId", "sender", "sms" }`. It only
accepts configured sender IDs, limits messages to 1,000 characters, deduplicates
retries, and matches the SMS amount/reference against unpaid orders. Ambiguous
or unmatched SMS messages are not marked paid.

1. In Render, set `MOMO_SMS_INGEST_TOKEN` to a newly generated random secret
   (for example, generate 32 random bytes with a trusted password manager or
   `openssl rand -hex 32`). Set `MOMO_SMS_ALLOWED_SENDERS` to the exact sender
   ID(s) used by the MoMo provider, comma-separated. Do not use a customer
   phone number, and do not put the token in source control.
2. On Android, install Termux and its matching Termux:API app from the same
   trusted source. In Termux, install `bash`, `curl`, `jq`, and `termux-api`,
   grant SMS permission to Termux:API, and copy `scripts/momo-sms-bridge.sh`
   to the phone. Create `~/.config/yebs-momo-bridge.env` with:

   ```sh
   export MOMO_SMS_API_URL='https://your-service.onrender.com/api/payments/momo/sms/ingest'
   export MOMO_SMS_INGEST_TOKEN='the-secret-configured-in-render'
   export MOMO_SMS_ALLOWED_SENDERS='official-sender-id'
   export MOMO_SMS_DEVICE_ID='a-stable-private-device-id'
   ```

   Restrict that file to the phone user's account; the script sets its
   permissions to owner-only when run. Run `chmod +x momo-sms-bridge.sh` and
   `./momo-sms-bridge.sh` in Termux; `--once` checks the inbox once, otherwise
   it polls every five minutes. Keep Android's background/battery restrictions
   in mind.
3. iOS does not allow a shell script or Shortcut to silently read the SMS
   inbox. For iPhone, create a personal Shortcut that asks for the copied SMS
   text, generates a unique message ID, and uses **Get Contents of URL** to
   POST JSON containing `deviceId`, `messageId`, `sender`, and `sms` to the
   HTTPS endpoint. Add `Authorization: Bearer <token>` and
   `Content-Type: application/json` headers. The sender must match the
   configured allowlist. Store the bridge token in the Shortcut's private
   configuration, not in a shared link. Run it manually after copying the
   message; unattended inbox access is not supported on iOS.
4. Check the order's payment status in the admin dashboard. Invalid, duplicate,
   ambiguous, unmatched, or unavailable-server responses must not be treated
   as proof of payment.

The phone should use the deployed HTTPS origin (for example,
`https://your-service.onrender.com`) and must never log or share the bearer
token or full payment SMS. If the Render environment values are missing, the
endpoint returns an explicit configuration error and does not verify payment.

Customer order lookup, tracking, cancellation, payment requests, and receipt
submission use a per-order access token returned at checkout and kept in that
browser's local storage. Customers should keep the checkout browser/device;
the token is not recoverable from the order number alone.

### Optional: use Supabase instead of the Render database

Put the Supabase **session-pooler** URI in `DATABASE_POOL_URL`, or set
`SUPABASE_SERVICE_ROLE_KEY` and run `supabase/yebs_state.sql` once.
When a pooler URI uses the default `postgres` username, the server qualifies it
with the project reference from `SUPABASE_URL`, as required by Supabase's pooler.

Locally:
```bash
node scripts/set-db-password.js "YOUR-SUPABASE-DATABASE-PASSWORD"
```

creates `public.yebs_state`, seeds it from `database.json` and verifies the
connection.

### Troubleshooting `P1001: Can't reach database server`

`P1001` is a Prisma error. It appears when a Render service still runs a Prisma
command, and Prisma is pointed at the IPv6-only Supabase direct host
(`db.<ref>.supabase.co`), which Render cannot reach.

1. **Render → your service → Settings → Build & Deploy**
   - **Build Command:** `npm install --omit=dev`
   - **Pre-Deploy Command:** leave **empty**
   - **Start Command:** `node server.js`
   - **Health Check Path:** `/api/health`
   - Press **Save**, then **Clear build cache & deploy**.
2. Or skip all of that and use the Blueprint: delete the old service, open
   <https://render.com/deploy?repo=https://github.com/stephenbelemtuguri/yebsnoodles>
   and press **Apply**. It creates `yebs-db` and injects `DATABASE_URL`, so
   Prisma and Supabase are not involved at all.
3. If you really want Supabase on Render, use the **session pooler** URI in
   `DATABASE_POOL_URL` (never the `db.<ref>.supabase.co` host).

### Share the Render database with Netlify

Render → `yebs-db` → **Connect** → copy the **External Database URL** and add it
to Netlify as `DATABASE_URL`. Both the Render site and the Netlify site then read
and write the same orders, menu and drivers — no Supabase key required.

## 4. First sign-in and setup

1. Open `https://<your-service>.onrender.com/admin.html`.
2. Sign in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set in the
   environment (the administrator is created on first boot). There is no
   built-in default administrator password; configure both values before sign-in.
3. Go to **Settings → Shared Pickup Point**: search a landmark, drop the pin and
   set the delivery fee, then **Save & sync to all maps**.
4. Go to **Noodles Menu & Photos** to edit prices, descriptions, prep times,
   availability and photos, or add/delete dishes.
5. Optional: place one test order and check `GET /api/admin/notifications` to see
   the WhatsApp delivery status (`sent`, `failed`, `not-configured`).

Change the admin password in **Settings** before going live.

### Forgot the password?

Both login pages have **Forgot your password?**. It sends a 6-digit code over
WhatsApp when `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
`ADMIN_RECOVERY_PHONE` are set. If no email, SMS, or WhatsApp provider delivers
the code, an admin-only fallback writes the 10-minute, single-use code to the
restricted Render service logs. In the Render Dashboard, open the service's
**Logs**, request recovery again, and search for
`Admin password recovery code`. Do not share the code or expose service logs.
If you cannot access the logs, reset the password from a trusted shell:

```bash
npm run reset:password -- admin "NewStrongPassword"
npm run reset:password -- driver "NewStrongPassword" 0541234567
```

The script uses the same `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (or
`DATABASE_URL`) the service uses. `RECOVERY_SHOW_CODE=1` only reveals codes for
requests received directly from localhost and has no effect on public requests;
do not configure it on Render.

## 5. Notes

- **Database persistence:** data lives in the Render PostgreSQL database, so
  redeploys and restarts keep orders, drivers and menu edits.
- **Free plan limits:** the free web service sleeps after inactivity (the first
  request can take ~30 s) and Render's free PostgreSQL expires after 30 days.
  Change `plan: free` to `starter` and the database to `basic-256mb` for
  production.
- **Single instance:** keep one web instance. The JSON state document is one row;
  multiple instances can overwrite each other. Scale with Supabase if needed.
- **HTTPS:** Render provides TLS automatically, so the live GPS button and the
  driver webcam work without extra configuration.
- **Logs:** Render → your service → **Logs** shows requests, WhatsApp errors and
  database writes.
- **Health check:** `/api/health` returns HTTP 200 and reports
  `database.persistent: true` and `database.writable: true` when the database
  is connected; it returns HTTP 503 when persistence is unavailable.

## 6. Custom domain (optional)

Render → your service → **Settings → Custom Domains** → add the domain, then
point the DNS record Render shows. No code change is needed — the API is on the
same origin as the pages.
