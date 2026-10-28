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
| `DATABASE_URL` | from `yebs-db` (automatic) | Orders, menu and drivers |
| `WHATSAPP_TOKEN` | Meta permanent token | Automatic order alerts |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number ID | Automatic order alerts |
| `WHATSAPP_TO` | `233559103452` | Kitchen number |
| `WHATSAPP_API_VERSION` | `v20.0` | Graph API version |
| `SUPABASE_URL` | `https://dujmpwcarxliadnfdydr.supabase.co` | Optional shared DB |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key | Optional shared DB (REST) |
| `SUPABASE_STATE_TABLE` | `yebs_state` | Optional shared DB |
| `DATABASE_POOL_URL` | Supabase session-pooler URI | Optional, overrides Render DB |
| `MOMO_SUBSCRIPTION_KEY` | MTN key | Optional automatic MoMo |
| `MOMO_API_USER` | MTN API user | Optional automatic MoMo |
| `MOMO_API_KEY` | MTN API key | Optional automatic MoMo |
| `MOMO_CALLBACK_HOST` | `https://your-service.onrender.com` | Optional automatic MoMo |
| `MOMO_TARGET_ENV` | `sandbox` or `mtnghana` | MoMo environment |
| `MOMO_PAY_TO` | `0559103452` | Wallet that receives payment |
| `MOMO_MERCHANT_NAME` | `MATHEW TIA` | Wallet account name |

`GET /api/health` shows the storage mode and whether WhatsApp is configured:

```json
{
  "storage": "postgres",
  "database": { "engine": "postgres", "persistent": true },
  "whatsapp": { "configured": true, "to": "233 559 103 452" }
}
```

### Optional: use Supabase instead of the Render database

Put the Supabase **session-pooler** URI in `DATABASE_POOL_URL`, or set
`SUPABASE_SERVICE_ROLE_KEY` and run `supabase/yebs_state.sql` once. Locally:

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
   environment (the administrator is created on first boot).
3. Go to **Settings → Shared Pickup Point**: search a landmark, drop the pin and
   set the delivery fee, then **Save & sync to all maps**.
4. Go to **Noodles Menu & Photos** to edit prices, descriptions, prep times,
   availability and photos, or add/delete dishes.
5. Optional: place one test order and check `GET /api/admin/notifications` to see
   the WhatsApp delivery status (`sent`, `failed`, `not-configured`).

Change the admin password in **Settings** before going live.

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
- **Health check:** `/api/health` reports `storage: postgres` and
  `database.persistent: true` when the database is connected.

## 6. Custom domain (optional)

Render → your service → **Settings → Custom Domains** → add the domain, then
point the DNS record Render shows. No code change is needed — the API is on the
same origin as the pages.
