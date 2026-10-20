# CI/CD

Everything lives in `.github/workflows/ci.yml`.

| Trigger | What runs |
|---|---|
| Pull request to `main` | Lint, typecheck, test, build → **preview deploy** to Vercel |
| Push to `main` (a merge) | Lint, typecheck, test, build → **production deploy** to Vercel |

Nothing deploys unless the `CI passed` gate succeeds. Vercel's own Git
integration is turned off in `vercel.json`, so these jobs are the only way a
deployment happens. CI does not touch the database; see
[Database migrations](#database-migrations).

Pull requests from forks skip the preview deploy, because GitHub gives them no
secrets.

## One-time setup

### 1. Link the Vercel project

```bash
npx vercel link
```

This writes `.vercel/project.json` (gitignored). The `orgId` and `projectId`
in it are the values for the secrets below. Set the app's environment variables
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GROQ_API_KEY`,
Google OAuth) in the Vercel dashboard under both **Production** and
**Preview**. `vercel pull` fetches them during each deploy.

### 2. Add repository secrets

GitHub → Settings → Secrets and variables → Actions:

| Secret | Where to get it |
|---|---|
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens |
| `VERCEL_ORG_ID` | `orgId` in `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | `projectId` in `.vercel/project.json` |

### 3. Create the `production` and `preview` environments

GitHub → Settings → Environments. The jobs create them automatically on first
run, but creating `production` yourself lets you add a required reviewer or
restrict it to `main`.

## Database migrations

Migrations in `supabase/migrations/` are not applied by CI. Apply them to the
production project yourself (`supabase db push`, or the SQL editor) **before**
merging code that depends on them: the scan quota, for one, fails closed when
its function is missing. Keep them backwards compatible with the code already
live: add columns and functions freely, but drop or rename only in a later PR,
after the code that used them is gone.
