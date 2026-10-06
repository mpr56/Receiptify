-- Receiptly: per-user rate limiting for the OCR scan endpoint.
--
-- Every scan spends real tokens at the vision provider, and a signed-in caller
-- can hit /api/scan in a loop. An in-process counter would reset on deploy and
-- would not be shared between serverless instances, so the counter lives here.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
-- One row per user per hourly window. window_start is the truncated hour, so
-- rows are naturally bucketed and the primary key does the deduplication.

create table if not exists public.scan_usage (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (user_id, window_start)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Read-only to the owner, for a future "scans remaining" display. Writes go
-- exclusively through consume_scan_quota below, which is SECURITY DEFINER —
-- granting write access here would let a client reset its own counter.

alter table public.scan_usage enable row level security;

grant select on public.scan_usage to authenticated;

drop policy if exists scan_usage_owner_read on public.scan_usage;
create policy scan_usage_owner_read on public.scan_usage
  for select
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- consume_scan_quota — atomically claim one scan
-- ---------------------------------------------------------------------------
-- The check and the increment are a single statement. Doing this as a SELECT
-- followed by an UPDATE would let two concurrent requests both read a count
-- under the limit and both proceed, which is exactly the case a rate limit
-- exists to stop.
--
-- ON CONFLICT ... WHERE means the update is skipped once the limit is reached,
-- so RETURNING yields no row and the caller learns it was denied.
--
-- SECURITY DEFINER because the caller must not be able to write this table
-- directly; auth.uid() is still what identifies them, so one user cannot spend
-- or inspect another's quota.

create or replace function public.consume_scan_quota(p_limit int)
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_window timestamptz := date_trunc('hour', now());
  v_count  int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_limit is null or p_limit < 1 then
    raise exception 'p_limit must be positive';
  end if;

  -- Keep the table from growing without bound. Scoped to the caller's own
  -- rows, so this stays cheap and needs no scheduled job.
  delete from public.scan_usage
   where user_id = v_user
     and window_start < v_window - interval '24 hours';

  insert into public.scan_usage (user_id, window_start, count)
  values (v_user, v_window, 1)
  on conflict (user_id, window_start) do update
     set count = public.scan_usage.count + 1
   where public.scan_usage.count < p_limit
  returning count into v_count;

  -- No row returned means the WHERE above rejected the update: quota spent.
  return v_count;
end;
$$;

revoke all on function public.consume_scan_quota(int) from public;
grant execute on function public.consume_scan_quota(int) to authenticated;
