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

## 1. Create the Supabase table (one time)

1. Open <https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new>
2. Paste the contents of [`supabase/yebs_state.sql`](supabase/yebs_state.sql) and press **Run**.
3. Open **Project Settings → API keys** and copy the **secret** / `service_role` key
   (not the publishable key). It is used only by the server.

## 2. Add the environment variables in Netlify

In the Netlify screen you were on (**Site configuration → Environment variables**),
add these one at a time (**Add a variable → Key + Value → Create variable**).
Leave "Scopes" on the default (all deploy contexts) and don't tick "Secret"
unless you want the value hidden after saving.

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://dujmpwcarxliadnfdydr.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the **secret** key from step 1.3 |
| `YEBS_AUTH_SECRET` | a long random string — generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_SECRET` | another long random string (same command) |
| `SESSION_SECRET` | another long random string (same command) |
| `NODE_ENV` | `production` |
| `LOG_FILE_ENABLED` | `false` |
| `BASE_URL` | `https://your-site-name.netlify.app` |

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
| Admin | `/admin` | `yebsnoodles` | `yebs@123` |
| Driver | `/driver` | created at signup | chosen at signup |

Change the admin password in **Admin → Login credentials** after the first login.

## 6. Driver sign-ups

Signing up creates a driver with status **pending**, and they cannot log in until
an administrator approves them:

1. Driver registers at `/driver` (camera photo required).
2. Admin opens `/admin` → **Drivers** → approve.
3. Driver signs in normally.

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
  earlier and forgotten. Reset it in Supabase → SQL Editor:

  ```sql
  update public.yebs_state
  set data = jsonb_set(
    data,
    '{admins}',
    '[{"id":"adm-1","username":"yebsnoodles","password":"yebs@123","name":"YEBS Administrator","role":"SUPERADMIN"}]'::jsonb
  )
  where id = 'main';
  ```

  The API re-hashes it on the next request; orders and drivers are untouched.
- **Photo upload fails**: keep photos under 6 MB; the driver page already
  downsizes face photos to 480 px.
