import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

export async function GET() {
  try {
    const supabase = getSupabase()

    const { data, error } = await supabase
      .from('snapstamp_photos')
      .select('*')
      .order('taken_at', { ascending: false })
      .limit(500)

    if (error) throw new Error(error.message)

    const photos = data || []

    // Generate fresh signed URLs (1 hour) for each photo so they always load
    // regardless of whether the bucket is public or private
    const withSignedUrls = await Promise.all(
      photos.map(async (photo: { id: string; url: string; path: string; taken_at: string; type: string }) => {
        if (!photo.path) return photo
        try {
          const { data: signed } = await supabase.storage
            .from('photo-pins')
            .createSignedUrl(photo.path, 3600)
          return { ...photo, url: signed?.signedUrl || photo.url }
        } catch {
          return photo
        }
      })
    )

    return NextResponse.json({ photos: withSignedUrls })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch photos'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
