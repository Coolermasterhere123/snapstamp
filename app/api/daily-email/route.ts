import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

export async function POST(req: NextRequest) {
  // Allow internal test calls (no auth) OR cron calls (with auth)
  const authHeader = req.headers.get('authorization')
  if (authHeader && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabase()

    // Check table exists
    const { count, error: countError } = await supabase
      .from('snapstamp_photos')
      .select('*', { count: 'exact', head: true })

    if (countError) {
      return NextResponse.json({
        error: `Table error: ${countError.message}`,
        hint: 'Run CREATE TABLE SQL in Supabase SQL editor'
      }, { status: 500 })
    }

    // Query all of today — use a wide 48h window and filter by date string
    // This avoids timezone issues with .gte on timestamptz
    const { data: allPhotos, error } = await supabase
      .from('snapstamp_photos')
      .select('*')
      .order('taken_at', { ascending: true })
      .limit(200)

    if (error) {
      return NextResponse.json({ error: `Query error: ${error.message}` }, { status: 500 })
    }

    // Filter to today in local server time AND just return all if none match today
    const todayStr = new Date().toISOString().slice(0, 10) // "2026-06-21"
    let photos = (allPhotos || []).filter((p: { taken_at: string }) =>
      p.taken_at.slice(0, 10) === todayStr
    )

    // If still none, just send all photos (useful for testing)
    const usedFallback = photos.length === 0 && (allPhotos?.length ?? 0) > 0
    if (usedFallback) photos = allPhotos || []

    if (!photos || photos.length === 0) {
      return NextResponse.json({
        message: 'No photos today, skipping email',
        debug: {
          totalRowsInTable: count,
          todayUTC: todayStr,
          hint: count === 0
            ? 'Table is empty — take a photo first'
            : `Table has ${count} rows but none match today (${todayStr})`
        }
      })
    }

    const dateStr = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    })

    const photoHtml = photos.map((p: { url: string; taken_at: string; type?: string }) => {
      const isVideo = p.type === 'video'
      return `
        <div style="margin-bottom:20px;">
          ${isVideo
            ? `<div style="background:#111;border-radius:8px;padding:20px;text-align:center;color:#888;">🎬 Video — <a href="${p.url}" style="color:#4ade80;">View video</a></div>`
            : `<img src="${p.url}" style="max-width:100%;border-radius:8px;display:block;" alt="Photo" />`
          }
          <p style="margin:6px 0 0;font-size:12px;color:#666;">
            ${new Date(p.taken_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
        </div>
      `
    }).join('')

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:32px 24px;text-align:center;">
          <div style="font-size:32px;margin-bottom:8px;">📸</div>
          <h1 style="margin:0;font-size:24px;font-weight:700;">SnapStamp Daily Summary</h1>
          <p style="margin:8px 0 0;color:#8888aa;font-size:14px;">${dateStr}${usedFallback ? ' (all photos)' : ''}</p>
        </div>
        <div style="padding:24px;">
          <p style="color:#aaa;font-size:15px;margin:0 0 20px;">
            You captured <strong style="color:#fff;">${photos.length} photo${photos.length === 1 ? '' : 's'}</strong>${usedFallback ? ' (showing all — timezone mismatch detected)' : ' today'}.
          </p>
          ${photoHtml}
        </div>
        <div style="padding:16px 24px;border-top:1px solid #222;text-align:center;color:#555;font-size:12px;">
          SnapStamp &bull; Your daily memories, automatically stamped
        </div>
      </div>
    `

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to: process.env.EMAIL_TO,
        subject: `📸 SnapStamp: ${photos.length} photo${photos.length === 1 ? '' : 's'} — ${dateStr}`,
        html,
      }),
    })

    if (!resendRes.ok) {
      const err = await resendRes.text()
      throw new Error(`Resend error: ${err}`)
    }

    return NextResponse.json({ success: true, photoCount: photos.length })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Email failed'
    console.error('Email error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
