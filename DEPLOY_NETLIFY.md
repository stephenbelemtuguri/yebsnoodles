# Deploying YEBS Noodles to Netlify

The site is static HTML plus an Express API. Netlify serves the pages from
`dist/` and runs the API as a single serverless function, with data stored in
Supabase.

```
Browser ──► Netlify CDN (index.html, admin.html, driver.html, images)
   │
   └─ /api/* ──► Netlify Function (Express app) ──► Supabase (yebs_state)
```

---

## 1. Connect Supabase (one time)

Choose **one** of these:

**A. Database URL (creates the table automatically).** Supabase → Project
Settings → Database → Connection string → **Session pooler**. Put the URI in
`DATABASE_POOL_URL` (and `DATABASE_URL`).

> Use the **Session pooler** host (`aws-0-<region>.pooler.supabase.com:6543`),
> **not** `db.<ref>.supabase.co`. The direct host is IPv6-only, and Render,
> Netlify and most home ISPs cannot reach it — that is the `P1001` /
> `ENOTFOUND` error.

The easiest way to set the password (it URL-encodes `@ : # /` for you):

```bash
node scripts/set-db-password.js "YOUR-SUPABASE-DATABASE-PASSWORD"
# or
npm run db:password -- "YOUR-SUPABASE-DATABASE-PASSWORD"
```

That writes `DATABASE_PASSWORD`, `DATABASE_URL` and `DATABASE_POOL_URL`, then
runs `supabase:setup`, which creates `public.yebs_state`, enables RLS, seeds it
from `database.json` and reads the row back.

**B. Service-role key.** Open
<https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new>, paste
[`supabase/yebs_state.sql`](supabase/yebs_state.sql) and press **Run**. Then copy
the **secret** / `service_role` key from **Project Settings → API keys** (not the
publishable key). It is used only by the server.

Locally, `npm run supabase:setup` creates the table, seeds it from
`database.json` and verifies the connection.

**C. Reuse the Render database.** If you deploy on Render first, open
`yebs-db` → **Connect** → copy the **External Database URL** and add it as
`DATABASE_URL` in Netlify. Both sites then share the same data, and you do not
need a Supabase key at all.

## 2. Add the environment variables in Netlify

In the Netlify screen you were on (**Site configuration → Environment variables**),
add these one at a time (**Add a variable → Key + Value → Create variable**).
Leave "Scopes" on the default (all deploy contexts) and don't tick "Secret"
unless you want the value hidden after saving.

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://dujmpwcarxliadnfdydr.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the **secret** key from option B (optional if using A) |
| `DATABASE_POOL_URL` | session-pooler URI from option A (optional if using B) |
| `DATABASE_URL` | direct URI from option A, or the Render external URL (optional if using B) |
| `YEBS_AUTH_SECRET` | a long random string — generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_SECRET` | another long random string (same command) |
| `SESSION_SECRET` | another long random string (same command) |
| `NODE_ENV` | `production` |
| `LOG_FILE_ENABLED` | `false` |
| `BASE_URL` | `https://your-site-name.netlify.app` |

### Password recovery delivery

Add at least one email provider and one phone provider if codes should arrive
through both channels. Set these as Netlify environment variables; never commit
the secret values:

| Key | Value |
|---|---|
| `SENDGRID_API_KEY` | SendGrid API key with Mail Send permission |
| `SENDGRID_FROM_EMAIL` | Verified sender address in SendGrid |
| `SENDGRID_FROM_NAME` | `YEBS Noodles` (optional) |
| `SMTP_USER` / `SMTP_PASSWORD` | SMTP account and app password (fallback email provider) |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | Twilio-enabled sender number |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API credentials (phone fallback) |

The server tries SendGrid then SMTP for email, and Twilio then WhatsApp for
phone delivery. Check `/api/health` → `recoveryDelivery` for boolean readiness
status; it does not expose credentials. SendGrid must use a verified sender.

### Optional: automatic WhatsApp order alerts (no redirect)

Every new order is sent to the kitchen in the background by the server. Without
these variables the order is still saved and the admin dashboard shows it — the
notification is recorded as `not-configured` and nothing is opened on the
customer's phone. To switch on real WhatsApp messages, add:

| Key | Value |
|---|---|
| `WHATSAPP_TOKEN` | permanent token from Meta → WhatsApp → API setup |
| `WHATSAPP_PHONE_NUMBER_ID` | the WhatsApp business phone number ID |
| `WHATSAPP_TO` | kitchen number, digits only — defaults to `233559103452` |
| `WHATSAPP_API_VERSION` | `v20.0` (default) |

`/api/health` reports `whatsapp.configured` so you can confirm it without
placing an order. Recent attempts are visible at `/api/admin/notifications`.

### Optional: real MTN MoMo payment prompts

The checkout always works with the USSD flow (dial `*170#` / `*110#`, pay,
enter the transaction ID). If you have a **MTN MoMo Collections API** account
from <https://momodeveloper.mtn.com>, add these too and the "Send payment
prompt" button becomes live — the server pushes a payment request straight to
the customer's phone and confirms it automatically.

| Key | Value |
|---|---|
| `MTN_MOMO_SUBSCRIPTION_KEY` | primary key of your MoMo API subscription |
| `MTN_MOMO_API_USER` | the API user UUID you created |
| `MTN_MOMO_API_KEY` | the API key generated for that user |
| `MTN_MOMO_TARGET_ENV` | `mtnghana` (sandbox: `sandbox`) |
| `MTN_MOMO_CALLBACK_HOST` | optional host for settlement callbacks |
| `MOMO_PAY_TO` | wallet that receives the money — defaults to `0559103452` |

Telecel Cash and AT Money do not expose a public collections API, so those
always use USSD plus transaction-ID/receipt confirmation. Without the MTN keys
`/api/health` reports `momo.apiConfigured: false` and every flow still works.

`YEBS_AUTH_SECRET` must stay stable — if it changes, everyone is signed out.
Never commit these values to git; keep them only in Netlify's environment
variables (and in your local `.env`, which is git-ignored).
Do **not** put the service_role key in any HTML file or public script.

## 3. Build settings

`netlify.toml` already contains them, so the deploy screen should show:

- **Build command:** `node scripts/netlify-build.js`
- **Publish directory:** `dist`
- **Functions directory:** `netlify/functions`

If the UI asks for them, type those values.

## 4. Check the deploy actually connected

After the first deploy, open:

```
https://your-site-name.netlify.app/api/health
```

You want:

```json
{ "success": true, "service": "YEBS Noodles API", "storage": "supabase" }
```

- `"storage": "supabase"` → everything is wired correctly.
- `"storage": "supabase-error: ..."` → the key/table is wrong; the site still
  works but nothing is saved between visits. Fix the variables in step 2 and
  redeploy.
- A 404 or "Page not found" → the redirect didn't deploy; make sure
  `netlify.toml` is in the repository root.

## 5. First sign-in

| Portal | URL | Username | Password |
|---|---|---|---|
| Admin | `/admin` | your `ADMIN_USERNAME` | your `ADMIN_PASSWORD` |
| Driver | `/driver` | created at signup | chosen at signup |

Change the admin password in **Admin → Login credentials** after the first login.

## 6. Driver sign-ups

Signing up creates a driver with status **pending**, and they cannot log in until
an administrator approves them:

1. Driver registers at `/driver` (camera photo required).
2. Admin opens `/admin` → **Drivers** → approve.
3. Driver signs in normally.

This gate depends on `SUPABASE_SERVICE_ROLE_KEY`. Without it every function
instance keeps its own in-memory copy, so a sign-up handled by one instance is
invisible to the admin handled by another — and approvals appear to "do nothing".
Check `/api/health`: it must say `"storage": "supabase"` before testing the gate.

## 7. Checkout, location and payment

- **Collection is the default.** Every customer collects at the single shared
  pickup point the admin sets in **Admin → Shared Pickup Point** (search any
  landmark online or click/drag the pin on the map). Collection adds no fee.
- **Delivery** is optional and adds the admin's delivery fee. Only then does the
  rider navigate to the customer's own GPS pin or typed address.
- **Use my live GPS location** starts a live `watchPosition` stream, keeps the
  most accurate fix, reverse-geocodes it online and drops a pin on the map. It
  needs `https://` (or `localhost`); a blocked permission shows a clear
  instruction instead of doing nothing.
- **Landmark search** queries OpenStreetMap (through `/api/geo/search`) as you
  type, so any area — `ATU`, `Madina`, `Kaneshie`, `Tema`, `Kumasi` — returns
  real nearby landmarks. Results are cached for a day. If the network is down a
  built-in Ghana landmark list is used.
- **Pay now** shows the network panel. The USSD codes are MTN `*170#`,
  Telecel Cash `*110#` and AT Money `*110#` (Telecel and AT share the code; the
  SIM decides which wallet opens).
- After the order is placed the payment screen opens with the amount, the order
  reference, the dial button, a transaction-ID box and a receipt upload. Proof
  is verified instantly against the order total.
- **Pay on delivery** skips all of that; the rider collects the cash and the
  order is marked paid at handover.
- **No WhatsApp redirect.** The customer never leaves the site to send the
  order; the backend delivers the alert itself.

## 8. Managing the menu and the pickup point

- **Admin → Noodles Menu & Photos** edits every detail of a food card: name,
  price, highlight tag, customer description, preparation time, availability,
  recipe text, photo (folder, URL or upload) and template. **Add new dish**
  creates a new card; **Delete** removes one. Every change is saved to the
  database and appears on the storefront immediately.
- **Admin → Shared Pickup Point** stores the name, address, latitude/longitude
  and the delivery fee in `settings.pickup` + `settings.deliveryFee`, and
  mirrors it into the active session so every map and open order updates.
- **Logout** on the admin, driver and portal pages clears both the session and
  the persisted token, then returns to the sign-in screen.

## Render hosting

`render.yaml` deploys the same Express app as a normal Node web service with a
persistent disk. See [`DEPLOY_RENDER.md`](DEPLOY_RENDER.md).

## Local development

```bat
npm install
npm start
```

This uses `database.json` unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
are present in `.env`, in which case it uses Supabase too.

## Troubleshooting

- **"Database unavailable"** in the browser: the function cannot reach Supabase.
  Check the two Supabase variables and that `yebs_state` exists.
- **Login says "Invalid administrator credentials"**: the password was changed
  earlier and forgotten. Re-run [`supabase/setup.sql`](supabase/setup.sql) to
  create the table, then set `ADMIN_USERNAME` / `ADMIN_PASSWORD` and restart so
  the app seeds the administrator. Full instructions:
  [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).
- **Photo upload fails**: keep photos under 6 MB; the driver page already
  downsizes face photos to 480 px.
