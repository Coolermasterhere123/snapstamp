import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lat = searchParams.get('lat')
  const lng = searchParams.get('lng')

  if (!lat || !lng) {
    return NextResponse.json({ error: 'Missing lat/lng' }, { status: 400 })
  }

  const apiKey = process.env.OPENWEATHER_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'No API key' }, { status: 500 })
  }

  try {
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${apiKey}`,
      { next: { revalidate: 300 } }
    )
    if (!res.ok) throw new Error('OpenWeatherMap error')
    const data = await res.json()
    return NextResponse.json({
      temp: data.main.temp,
      city: data.name,
      country: data.sys.country,
    })
  } catch (e) {
    return NextResponse.json({ error: 'Weather fetch failed' }, { status: 500 })
  }
}
