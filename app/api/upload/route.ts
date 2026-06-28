import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 60

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Vercel')
  return createClient(url, key)
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

    const supabase = getSupabase()
    const buffer = Buffer.from(await file.arrayBuffer())
    const filename = file.name || `snap_${Date.now()}.jpg`
    const isVideo = filename.match(/\.(mp4|webm|mov)$/i)
    const path = `snapstamp/${isVideo ? 'videos' : 'photos'}/${filename}`
    const contentType = isVideo ? (file.type || 'video/webm') : 'image/jpeg'

    const { error } = await supabase.storage
      .from('photo-pins')
      .upload(path, buffer, { contentType, upsert: false })

    if (error) throw new Error(`Supabase storage error: ${error.message}`)

    const { data: { publicUrl } } = supabase.storage.from('photo-pins').getPublicUrl(path)

    try {
      await supabase.from('snapstamp_photos').insert({
        url: publicUrl,
        path,
        taken_at: new Date().toISOString(),
        type: isVideo ? 'video' : 'photo',
      })
    } catch { /* non-fatal if table doesn't exist */ }

    return NextResponse.json({ url: publicUrl })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Upload failed'
    console.error('Upload error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
