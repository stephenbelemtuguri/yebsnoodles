# Deploying YEBS Noodles on Render

Render runs the whole app as one Node web service: the Express API and the
static pages (`index.html`, `admin.html`, `driver.html`, `public/`) are served
from the same origin, so nothing else is required.

```
Browser ──► Render web service (Express) ──► /var/data/database.json (persistent disk)
                                      └──► Supabase (optional, shared state)
```

`render.yaml` in the repo root is a Blueprint, so Render can create the service,
the disk and the environment variables in one go.

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
3. Render reads `render.yaml` and shows the `yebs-noodles` service with a 1 GB
   disk mounted at `/var/data`.
4. Fill in the variables marked `sync: false` (WhatsApp, Supabase, MTN). They are
   optional — press **Apply** and the site still works without them.
5. Wait for the first deploy. The health check is `GET /api/health`.

> If you prefer a manual **New → Web Service**, use:
> **Runtime** Node, **Build** `npm install --omit=dev`, **Start** `node server.js`,
> **Health check** `/api/health`, then add the same environment variables and a
> disk mounted at `/var/data`.

## 3. Environment variables

| Key | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Production behaviour |
| `DB_PATH` | `/var/data/database.json` | Keeps data on the disk |
| `WHATSAPP_TOKEN` | Meta permanent token | Automatic order alerts |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number ID | Automatic order alerts |
| `WHATSAPP_TO` | `233559103452` | Kitchen number |
| `WHATSAPP_API_VERSION` | `v20.0` | Graph API version |
| `SUPABASE_URL` | `https://dujmpwcarxliadnfdydr.supabase.co` | Optional shared DB |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key | Optional shared DB (REST) |
| `SUPABASE_STATE_TABLE` | `yebs_state` | Optional shared DB |
| `DATABASE_POOL_URL` | session pooler URI with the real password | Optional shared DB (Postgres) |
| `DATABASE_URL` | direct URI with the real password | Fallback for Postgres |
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
  "database": { "engine": "supabase-postgres", "persistent": true },
  "whatsapp": { "configured": true, "to": "233 559 103 452" }
}
```

### Connecting Supabase (recommended)

You only need **one** of these:

1. **Database URL (simplest).** Supabase → Project Settings → Database →
   Connection string → **Session pooler**, then replace `[YOUR-PASSWORD]` with
   the real password. Put it in `DATABASE_POOL_URL` (and `DATABASE_URL`).
   The app creates `public.yebs_state` automatically on first boot and stores
   everything there.
2. **Service-role key.** Supabase → Project Settings → API Keys → secret /
   `service_role`. Put it in `SUPABASE_SERVICE_ROLE_KEY`, then run
   `supabase/yebs_state.sql` once in the SQL Editor.

Locally you can run `npm run supabase:setup` to create the table, seed it from
`database.json` and verify the connection.

## 4. First sign-in and setup

1. Open `https://<your-service>.onrender.com/admin.html`.
2. Sign in with `yebsnoodles` / `yebs@123` (created automatically on first boot).
3. Go to **Settings → Shared Pickup Point**: search a landmark, drop the pin and
   set the delivery fee, then **Save & sync to all maps**.
4. Go to **Noodles Menu & Photos** to edit prices, descriptions, prep times,
   availability and photos, or add/delete dishes.
5. Optional: place one test order and check `GET /api/admin/notifications` to see
   the WhatsApp delivery status (`sent`, `failed`, `not-configured`).

Change the admin password in **Settings** before going live.

## 5. Notes

- **Disk persistence:** the free instance type has no persistent disk. Use the
  `starter` plan (as in `render.yaml`) or connect Supabase and leave `DB_PATH`
  unset. `render.yaml` uses `starter` with a 1 GB disk.
- **Free plan sleep:** free web services sleep after inactivity; the first
  request after a nap can take ~30 s. A paid plan stays awake.
- **Single instance:** keep one instance. The JSON store is file-based; two
  instances would overwrite each other. Use Supabase if you need to scale.
- **HTTPS:** Render provides TLS automatically, so the live GPS button and the
  driver webcam work without extra configuration.
- **Logs:** Render → your service → **Logs** shows requests, WhatsApp errors and
  database writes.
- **Redeploys** keep `/var/data` intact; deleting the disk deletes the data.

## 6. Custom domain (optional)

Render → your service → **Settings → Custom Domains** → add the domain, then
point the DNS record Render shows. No code change is needed — the API is on the
same origin as the pages.
