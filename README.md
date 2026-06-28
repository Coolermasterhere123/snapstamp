# SnapStamp

A minimal PWA camera app that stamps every photo with date, time, temperature, and city — then emails you a daily summary.

## Supabase Setup

Run this SQL in your Supabase SQL editor:

```sql
CREATE TABLE IF NOT EXISTS snapstamp_photos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  url text NOT NULL,
  path text NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now()
);

-- Enable read access for the service role (already has it)
-- The photo-pins bucket should already exist from FriendMap
```

Make sure the `photo-pins` bucket exists and is public.

## Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your values.
Add the same variables in your Vercel project settings.

## Cron Job

The `/api/daily-email` route runs at 10pm UTC daily (configured in `vercel.json`).
It requires an `Authorization: Bearer YOUR_CRON_SECRET` header, which Vercel sends automatically.

To test manually:
```
POST /api/daily-email
Authorization: Bearer your-cron-secret
```
