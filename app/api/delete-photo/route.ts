import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

export async function DELETE(req: NextRequest) {
  try {
    const { id, path } = await req.json()
    if (!id && !path) return NextResponse.json({ error: 'Missing id or path' }, { status: 400 })

    const supabase = getSupabase()

    // Delete from storage
    if (path) {
      const { error: storageError } = await supabase.storage
        .from('photo-pins')
        .remove([path])
      if (storageError) console.warn('Storage delete warn:', storageError.message)
    }

    // Delete from database
    if (id) {
      const { error: dbError } = await supabase
        .from('snapstamp_photos')
        .delete()
        .eq('id', id)
      if (dbError) throw new Error(`DB delete error: ${dbError.message}`)
    } else if (path) {
      // fallback: delete by path
      await supabase.from('snapstamp_photos').delete().eq('path', path)
    }

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Delete failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
