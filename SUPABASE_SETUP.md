# Connect YEBS Noodles to Supabase

The app stores **everything** — orders, menu, drivers, admins, reviews, payouts
and settings — in **one** table: `public.yebs_state`. That is by design: the API
reads and writes one JSON document, so there are no separate tables to keep in
sync.

If the admin login fails on the deployed site, the app is still writing to the
local `database.json` and has never reached Supabase.

---

## Step 1 — create the table (2 minutes)

1. Open the SQL Editor:
   <https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new>
2. Open [`supabase/setup.sql`](supabase/setup.sql), copy the whole file, paste
   it into the editor and press **Run**.
3. The result should show `menu_items = 5`. `admins` stays `0` until the app
   boots with `ADMIN_USERNAME` / `ADMIN_PASSWORD` set.

`supabase/setup.sql` creates:

- `public.yebs_state` with RLS enabled (only the server can read/write),
- the menu (5 dishes), the pickup point and the MoMo wallet
  `0559103452` / `MATHEW TIA`,
- **no administrator password** — the app creates the admin from the
  environment on first boot.

It is safe to re-run: it never deletes orders, drivers or reviews.

> Regenerate it after editing `database.json`:
> `npm run supabase:sql`

---

## Step 2 — give the app the secret key (recommended)

1. Supabase → **Project Settings → API Keys** → copy the **secret** key
   (`sb_secret_...`, or the legacy `service_role` JWT).
2. Run:

   ```powershell
   cd "C:\Users\User\OneDrive\Desktop\stephen"
   npm run supabase:key -- "PASTE_THE_SECRET_KEY"
   ```

The script writes `SUPABASE_SERVICE_ROLE_KEY` to `.env` and checks the table.
You should see:

```
[supabase:key] connected. row=main menuItems=5 admins=[your-admin]
```

Why this method: it uses HTTPS (PostgREST), so it works on Render, Netlify and
any IPv4-only network. No database password, no pooler, no `P1001`.

### Alternative — database password

```powershell
npm run db:password -- "PASTE_THE_DATABASE_PASSWORD"
```

That uses the **session pooler**
(`aws-0-eu-west-1.pooler.supabase.com:6543`) and creates the table
automatically. The direct `db.<ref>.supabase.co` host is IPv6-only and fails on
Render with `P1001`.

---

## Step 3 — verify

Restart the app and open <http://localhost:3100/api/health>:

```json
{
  "storage": "supabase",
  "database": { "engine": "supabase-rest", "persistent": true }
}
```

or `"storage": "postgres"` if you used the password method. Then open
`/admin.html` and sign in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set
in `.env`.

Change the password in **Admin → Settings** after the first login.

---

## Production (Render + Netlify)

Add these environment variables in both dashboards:

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://dujmpwcarxliadnfdydr.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the secret key |
| `SUPABASE_STATE_TABLE` | `yebs_state` |
| `YEBS_AUTH_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_USERNAME` | your admin name |
| `ADMIN_PASSWORD` | a strong password (never commit it) |

On Render you can instead use the Blueprint's own PostgreSQL (`yebs-db`) and
skip Supabase entirely.

---

## Prisma

[`prisma/yebs.prisma`](prisma/yebs.prisma) matches the real table. If you have
the database password:

```bash
npm run db:push:yebs
```

`prisma/schema.prisma` is a normalized reference schema and is **not** used by
the running app.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PGRST205` / “Could not find the table” | Run `supabase/setup.sql` in the SQL Editor. |
| `401` from `/rest/v1/yebs_state` | You used the publishable key. Use the **secret** key. |
| Admin login fails | Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` and restart; the app seeds the admin when the row has none. |
| `storage: local-file` | No Supabase key or password in the environment. |
| `P1001` on Render | Use the session pooler or the Blueprint database; never `db.<ref>.supabase.co`. |
| Data appears then disappears | The app is on `local-file` on one host. Set the same Supabase variables on Render **and** Netlify. |
