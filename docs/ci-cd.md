# CI/CD

Everything lives in `.github/workflows/ci.yml`.

| Trigger | What runs |
|---|---|
| Pull request to `main` | Lint, typecheck, test, build → **preview deploy** to Vercel |
| Push to `main` (a merge) | Lint, typecheck, test, build → **Supabase migrations** → **production deploy** |

Nothing deploys unless the `CI passed` gate succeeds. The production deploy
waits for migrations, so new code never runs against a database missing the
tables or functions it needs. Vercel's own Git integration is turned off in
`vercel.json`, so these jobs are the only way a deployment happens.

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
| `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens |
| `SUPABASE_DB_PASSWORD` | The production database password |
| `SUPABASE_PROJECT_ID` | The project ref, from the dashboard URL (`supabase.com/dashboard/project/<ref>`) |

### 3. Create the `production` and `preview` environments

GitHub → Settings → Environments. The jobs create them automatically on first
run, but creating `production` yourself lets you add a required reviewer or
restrict it to `main`.

### 4. Mark existing migrations as applied

If you already ran `0001` and `0002` by hand in the SQL editor, the remote
migration history is empty and `supabase db push` would try to run them again.
Record them once, before the first merge:

```bash
supabase link --project-ref <ref>
supabase migration repair --status applied 0001 0002
```

## Writing migrations from now on

The migration runs **before** the new code deploys, so for a minute the old
code runs against the new schema. Keep migrations backwards compatible: add
columns and functions freely, but drop or rename only in a later PR, after the
code that used them is gone.
