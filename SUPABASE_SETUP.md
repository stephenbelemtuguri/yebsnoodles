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

## Want individual tables in the Supabase Table Editor?

By default, the app stores everything in `public.yebs_state` for extreme speed and atomic state transactions.

If you want human-readable, browsable tables in the Supabase Table Editor:
1. Open the SQL Editor: <https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new>
2. Paste [`supabase/separate_tables.sql`](supabase/separate_tables.sql) and click **Run**.

This sets up:
- `public.yebs_orders`, `public.yebs_drivers`, `public.yebs_admins`, `public.yebs_menu_items`, `public.yebs_reviews`, `public.yebs_audit_logs`, `public.yebs_settings`, and `public.yebs_sessions`.
- **Automatic triggers**: Whenever the app saves an order, rider signup, or review to `yebs_state`, it is instantly unpacked into the relational tables.
- **Reverse sync**: If you edit a menu price or order status directly inside the Supabase Table Editor, triggers automatically update `yebs_state` so the live site reflects your changes within seconds.

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

## Password recovery

Both login pages (Admin and Rider) have a **Forgot your password?** link that
opens a two-step dialog: request a 6-digit code, then set a new password.

| Piece | Detail |
|---|---|
| Code lifetime | 10 minutes, single use, 5 wrong attempts maximum |
| Storage | Only a bcrypt hash of the code is stored, in `recoveryCodes` inside `yebs_state` |
| Delivery | WhatsApp Cloud API (`WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`) |
| Admin phone | `ADMIN_RECOVERY_PHONE`, or the phone saved in Admin → Settings |
| Rider phone | The number used at sign-up |
| Session safety | A successful reset bumps `sessionEpoch`, signing out every old session |

When no email, SMS, or WhatsApp provider delivers an admin code, the server
writes the 10-minute, single-use code only to restricted service logs. An
authorized owner can request recovery and retrieve it from the hosting logs;
the public API response never includes this fallback code. Rider recovery
requires a configured delivery channel. The owner can also reset credentials
from a trusted shell:

```bash
# Reset the first admin account
npm run reset:password -- admin "NewStrongPassword"

# Reset a specific rider by username or phone
npm run reset:password -- driver "NewStrongPassword" 0541234567
```

The script writes to Supabase when `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set (the same store the deployed app uses),
otherwise to `database.json`.

> `RECOVERY_SHOW_CODE=1` only reveals codes for requests received directly from
> localhost. It has no effect on public requests; use it only for local development.

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
| Forgot the admin password | Use **Forgot your password?** on the login page, or run `npm run reset:password -- admin "NewPassword"` on the server. |
| Recovery code never arrives | Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ADMIN_RECOVERY_PHONE`; without them the code is printed in the server log. |
| `storage: local-file` | No Supabase key or password in the environment. |
| `P1001` on Render | Use the session pooler or the Blueprint database; never `db.<ref>.supabase.co`. |
| Data appears then disappears | The app is on `local-file` on one host. Set the same Supabase variables on Render **and** Netlify. |
