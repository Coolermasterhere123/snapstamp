'use client'

import { useRef, useState, useCallback, useEffect } from 'react'

type UploadStatus = 'idle' | 'stamping' | 'uploading' | 'done' | 'error'
type CaptureMode = 'photo' | 'video'
type RecordingState = 'idle' | 'recording' | 'stopping'

interface StampData {
  date: string
  time: string
  temp: string
  city: string
}

interface LocalPhoto {
  id: string
  url: string
  filename: string
  takenAt: string
  savedLocally: boolean
  type: 'photo' | 'video'
  blob?: Blob
}

interface CloudPhoto {
  id: string
  url: string
  path: string
  taken_at: string
  type: 'photo' | 'video'
}

const STORAGE_KEY = 'snapstamp_local_photos'

function saveMeta(photos: LocalPhoto[]) {
  try {
    const meta = photos.map(({ blob: _b, ...rest }) => rest)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meta))
  } catch { /* storage full */ }
}

function loadMeta(): LocalPhoto[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const stampDataRef = useRef<StampData | null>(null)
  const blobCache = useRef<Map<string, Blob>>(new Map())

  const [status, setStatus] = useState<UploadStatus>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment')
  const [errorMsg, setErrorMsg] = useState('')
  const [showGallery, setShowGallery] = useState(false)
  const [photos, setPhotos] = useState<LocalPhoto[]>([])
  const [selectedPhoto, setSelectedPhoto] = useState<LocalPhoto | null>(null)
  const [captureMode, setCaptureMode] = useState<CaptureMode>('photo')
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [emailMsg, setEmailMsg] = useState('')
  const [showManager, setShowManager] = useState(false)
  const [cloudPhotos, setCloudPhotos] = useState<CloudPhoto[]>([])
  const [managerLoading, setManagerLoading] = useState(false)
  const [managerError, setManagerError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [cloudPreview, setCloudPreview] = useState<CloudPhoto | null>(null)
  const [recordingSecs, setRecordingSecs] = useState(0)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { setPhotos(loadMeta()) }, [])

  // Back button trap — push a state whenever an overlay opens, pop it to close
  useEffect(() => {
    const onPop = () => {
      // Close overlays in reverse order of depth
      if (cloudPreview) { setCloudPreview(null); return }
      if (selectedPhoto) { setSelectedPhoto(null); return }
      if (showManager) { setShowManager(false); return }
      if (showGallery) { setShowGallery(false); return }
      // Nothing open — push state again so next back still doesn't exit
      history.pushState({ snap: true }, '')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [cloudPreview, selectedPhoto, showManager, showGallery])

  // Push a history entry whenever any overlay opens
  useEffect(() => {
    if (showGallery || showManager || selectedPhoto || cloudPreview) {
      history.pushState({ snap: true }, '')
    }
  }, [showGallery, showManager, selectedPhoto, cloudPreview])

  // On mount, push an initial state so the very first back press is caught
  useEffect(() => {
    history.pushState({ snap: true }, '')
  }, [])

  const startCamera = useCallback(async (mode: 'environment' | 'user' = 'environment') => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
        setCameraReady(true)
      }
    } catch {
      setErrorMsg('Camera access denied. Use the file picker instead.')
    }
  }, [])

  useEffect(() => {
    startCamera()
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()) }
  }, [startCamera])

  const getLocation = (): Promise<{ lat: number; lng: number }> =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('No geolocation'))
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        err => reject(err),
        { timeout: 8000 }
      )
    })

  const fetchStampData = async (): Promise<StampData> => {
    const now = new Date()
    const stamp: StampData = {
      date: now.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }),
      time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
      temp: '--',
      city: '',
    }
    try {
      const { lat, lng } = await getLocation()
      const res = await fetch(`/api/weather?lat=${lat}&lng=${lng}`)
      if (res.ok) {
        const w = await res.json()
        stamp.temp = `${Math.round(w.temp)}°C`
        stamp.city = w.city
      }
    } catch { /* no weather */ }
    return stamp
  }

  // Draw stamp onto canvas context — compact, fits any width
  const drawStamp = (ctx: CanvasRenderingContext2D, w: number, h: number, stamp: StampData) => {
    // Use smaller font — scale to image width, not height
    const fontSize = Math.max(11, Math.round(w * 0.022))
    const barH = Math.round(fontSize * 1.9)
    const pad = Math.round(fontSize * 0.6)

    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.fillRect(0, h - barH, w, barH)

    ctx.font = `500 ${fontSize}px -apple-system, system-ui, sans-serif`
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'

    // Build compact stamp without wide emoji spacing
    const parts = [
      `\uD83D\uDCF8 ${stamp.date} ${stamp.time}`,
      `${stamp.temp}`,
      stamp.city ? `\uD83D\uDCCD ${stamp.city}` : '',
    ].filter(Boolean).join('   ')

    ctx.fillText(parts, pad, h - barH / 2)
  }

  const stampImageBlob = async (imageBlob: Blob): Promise<{ blob: Blob; stamp: StampData }> => {
    const stamp = await fetchStampData()
    const blob = await new Promise<Blob>((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const MAX = 1200
        let w = img.width, h = img.height
        if (w > MAX || h > MAX) {
          const ratio = Math.min(MAX / w, MAX / h)
          w = Math.round(w * ratio); h = Math.round(h * ratio)
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        drawStamp(ctx, w, h, stamp)
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.88)
        URL.revokeObjectURL(img.src)
      }
      img.onerror = reject
      img.src = URL.createObjectURL(imageBlob)
    })
    return { blob, stamp }
  }

  const downloadBlob = (blob: Blob, filename: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  const uploadAndSave = async (blob: Blob, filename: string, type: 'photo' | 'video', id: string) => {
    let uploadedUrl: string | null = null
    let savedLocally = false

    try {
      const formData = new FormData()
      formData.append('file', blob, filename)
      const res = await fetch('/api/upload', { method: 'POST', body: formData })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Upload failed (${res.status})`)
      }
      uploadedUrl = (await res.json()).url
    } catch (uploadErr) {
      savedLocally = true
      downloadBlob(blob, filename)
      const msg = uploadErr instanceof Error ? uploadErr.message : 'Upload failed'
      setErrorMsg(`Saved locally (${msg})`)
    }

    blobCache.current.set(id, blob)
    const objectUrl = URL.createObjectURL(blob)

    const newPhoto: LocalPhoto = {
      id, url: uploadedUrl ?? objectUrl, filename,
      takenAt: new Date().toISOString(), savedLocally, type, blob,
    }
    setPhotos(prev => { const next = [newPhoto, ...prev]; saveMeta(next); return next })
    return savedLocally
  }

  // --- Photo capture ---
  const handlePhotoCapture = async (source: 'camera' | 'file', fileBlob?: Blob) => {
    setStatus('stamping'); setStatusMsg('Stamping…'); setErrorMsg('')
    const id = `snap_${Date.now()}`
    try {
      let rawBlob: Blob
      if (source === 'camera') {
        const video = videoRef.current!
        const canvas = canvasRef.current!
        canvas.width = video.videoWidth; canvas.height = video.videoHeight
        canvas.getContext('2d')!.drawImage(video, 0, 0)
        rawBlob = await new Promise<Blob>((res, rej) =>
          canvas.toBlob(b => b ? res(b) : rej(new Error('capture failed')), 'image/jpeg', 0.92)
        )
      } else {
        rawBlob = fileBlob!
      }
      const { blob: stamped } = await stampImageBlob(rawBlob)
      setStatus('uploading'); setStatusMsg('Uploading…')
      const local = await uploadAndSave(stamped, `${id}.jpg`, 'photo', id)
      setStatus('done'); setStatusMsg(local ? '📥 Saved locally!' : '✅ Uploaded!')
      setTimeout(() => { setStatus('idle'); setStatusMsg(''); setErrorMsg('') }, 3000)
    } catch (e: unknown) {
      setStatus('error')
      setErrorMsg(e instanceof Error ? e.message : 'Something went wrong')
      setTimeout(() => { setStatus('idle'); setErrorMsg('') }, 5000)
    }
  }

  // --- Video recording ---
  const startRecording = async () => {
    if (!streamRef.current) return
    recordedChunksRef.current = []
    setRecordingSecs(0)

    // Fetch stamp data upfront so it's ready for the first frame
    stampDataRef.current = await fetchStampData()

    const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
      : 'video/webm'

    const recorder = new MediaRecorder(streamRef.current, { mimeType })
    recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunksRef.current.push(e.data) }
    recorder.start(1000)
    mediaRecorderRef.current = recorder
    setRecordingState('recording')

    recordingTimerRef.current = setInterval(() => setRecordingSecs(s => s + 1), 1000)
  }

  const stopRecording = async () => {
    setRecordingState('stopping')
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)

    await new Promise<void>(resolve => {
      const recorder = mediaRecorderRef.current!
      recorder.onstop = () => resolve()
      recorder.stop()
    })

    const chunks = recordedChunksRef.current
    if (!chunks.length) { setRecordingState('idle'); return }

    const mimeType = mediaRecorderRef.current?.mimeType || 'video/webm'
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const videoBlob = new Blob(chunks, { type: mimeType })
    const id = `vid_${Date.now()}`
    const filename = `${id}.${ext}`

    setStatus('uploading'); setStatusMsg('Uploading video…')
    const local = await uploadAndSave(videoBlob, filename, 'video', id)
    setStatus('done'); setStatusMsg(local ? '📥 Saved locally!' : '✅ Video uploaded!')
    setTimeout(() => { setStatus('idle'); setStatusMsg('') }, 3000)
    setRecordingState('idle')
  }

  const handleShutter = () => {
    if (captureMode === 'photo') {
      if (status === 'idle') handlePhotoCapture('camera')
    } else {
      if (recordingState === 'idle') startRecording()
      else if (recordingState === 'recording') stopRecording()
    }
  }

  const flipCamera = async () => {
    const next = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(next)
    await startCamera(next)
  }

  const fmtSecs = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`

  const todayPhotos = photos.filter(p => p.takenAt.slice(0, 10) === todayStr())

  const handleDownload = async (photo: LocalPhoto) => {
    const cached = blobCache.current.get(photo.id)

    // Build a File object if we have the blob in memory
    if (cached) {
      const mimeType = photo.type === 'video' ? cached.type || 'video/mp4' : 'image/jpeg'
      const file = new File([cached], photo.filename, { type: mimeType })

      // Web Share API with files — on Android this opens the native share sheet
      // where the user can pick "Save to Photos" → goes to gallery / SD card
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'SnapStamp' })
          return
        } catch (e) {
          // User cancelled share — don't fall through to download
          if (e instanceof Error && e.name === 'AbortError') return
        }
      }

      // Fallback: trigger browser download (goes to Downloads folder)
      downloadBlob(cached, photo.filename)
      return
    }

    // No blob in memory (older session entry) — open cloud URL or try to fetch + share
    if (photo.url.startsWith('http')) {
      try {
        const res = await fetch(photo.url)
        const blob = await res.blob()
        const mimeType = photo.type === 'video' ? 'video/mp4' : 'image/jpeg'
        const file = new File([blob], photo.filename, { type: mimeType })
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'SnapStamp' })
          return
        }
      } catch { /* fall through */ }
      // Last resort: open in new tab
      window.open(photo.url, '_blank')
    }
  }

  const handleDelete = (photo: LocalPhoto) => {
    blobCache.current.delete(photo.id)
    setPhotos(prev => {
      const next = prev.filter(p => p.id !== photo.id)
      saveMeta(next)
      return next
    })
    if (selectedPhoto?.id === photo.id) setSelectedPhoto(null)
  }

  const sendTestEmail = async () => {
    setEmailStatus('sending')
    setEmailMsg('Sending…')
    try {
      const res = await fetch('/api/daily-email', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Error ${res.status}`)
      if (body.message) {
        setEmailStatus('error')
        setEmailMsg(body.debug?.hint || body.message)
      } else {
        setEmailStatus('sent')
        setEmailMsg(`✅ Sent! (${body.photoCount ?? 0} photos)`)
      }
    } catch (e) {
      setEmailStatus('error')
      setEmailMsg(e instanceof Error ? `❌ ${e.message}` : '❌ Failed')
    }
    setTimeout(() => { setEmailStatus('idle'); setEmailMsg('') }, 6000)
  }

  const openManager = async () => {
    setShowManager(true)
    setSelected(new Set())
    setManagerLoading(true)
    setManagerError('')
    try {
      const res = await fetch('/api/photos')
      if (!res.ok) throw new Error('Failed to load photos')
      const { photos: data } = await res.json()
      setCloudPhotos(data)
    } catch (e) {
      setManagerError(e instanceof Error ? e.message : 'Failed to load')
    }
    setManagerLoading(false)
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(cloudPhotos.map(p => p.id)))
  const clearSelection = () => setSelected(new Set())

  const deleteSelected = async () => {
    if (selected.size === 0) return
    setDeleting(true)
    const toDelete = cloudPhotos.filter(p => selected.has(p.id))
    await Promise.all(toDelete.map(p =>
      fetch('/api/delete-photo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id, path: p.path }),
      })
    ))
    setCloudPhotos(prev => prev.filter(p => !selected.has(p.id)))
    if (cloudPreview && selected.has(cloudPreview.id)) setCloudPreview(null)
    setSelected(new Set())
    setDeleting(false)
  }

  const shareCloudPhoto = async (photo: CloudPhoto) => {
    try {
      const res = await fetch(photo.url)
      const blob = await res.blob()
      const ext = photo.type === 'video' ? 'mp4' : 'jpg'
      const file = new File([blob], `snapstamp_${photo.id}.${ext}`, { type: blob.type })
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'SnapStamp' })
        return
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
    }
    // fallback — open in new tab
    window.open(photo.url, '_blank')
  }

  const deleteCloudPhoto = async (photo: CloudPhoto) => {
    await fetch('/api/delete-photo', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: photo.id, path: photo.path }),
    })
    setCloudPhotos(prev => prev.filter(p => p.id !== photo.id))
    setSelected(prev => { const n = new Set(prev); n.delete(photo.id); return n })
    setCloudPreview(null)
  }

  const isRecording = recordingState === 'recording'
  const isBusy = status !== 'idle' || recordingState === 'stopping'

  const modeBtn = (active: boolean): React.CSSProperties => ({ padding: '7px 24px', borderRadius: 26, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13, letterSpacing: 0.5, background: active ? '#fff' : 'transparent', color: active ? '#000' : 'rgba(255,255,255,0.6)', transition: 'all 0.2s' })
  const shutterStyle = (recording: boolean): React.CSSProperties => ({ width: 72, height: 72, borderRadius: '50%', background: recording ? '#ff3b30' : '#fff', border: `4px solid ${recording ? '#ff3b3066' : 'rgba(255,255,255,0.3)'}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 0 2px ${recording ? '#ff3b30aa' : 'rgba(255,255,255,0.5)'}`, flexShrink: 0, transition: 'all 0.2s' })
  const dotStyle = (err: boolean): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: err ? '#ff4444' : '#4ade80', animation: 'pulse 1.5s infinite', flexShrink: 0 })

  const s: Record<string, React.CSSProperties> = {
    root: { position: 'fixed', inset: 0, background: '#000', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    video: { flex: 1, width: '100%', objectFit: 'cover', display: cameraReady ? 'block' : 'none' },
    noCamera: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#666', fontSize: 14, textAlign: 'center', padding: 24 },
    controls: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: '16px 28px 38px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)' },
    modeBar: { position: 'absolute', bottom: 148, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 10 },
    iconBtn: { width: 48, height: 48, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(8px)', color: '#fff', fontSize: 20 },
    statusBar: { position: 'absolute', top: 0, left: 0, right: 0, padding: '12px 20px', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', gap: 10, color: '#fff', fontSize: 13, fontWeight: 500 },
    recBadge: { position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.6)', borderRadius: 20, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8, color: '#fff', fontSize: 13, fontWeight: 600, backdropFilter: 'blur(8px)' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.96)', zIndex: 60, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    overlayHeader: { padding: '20px 20px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #1a1a1a', flexShrink: 0 },
    grid: { flex: 1, overflowY: 'auto', padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignContent: 'start' },
    photoCard: { position: 'relative', borderRadius: 10, overflow: 'hidden', background: '#111', cursor: 'pointer', aspectRatio: '4/3' },
    lightbox: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.97)', zIndex: 70, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 20 },
  }

  return (
    <div style={s.root}>
      <video ref={videoRef} style={s.video} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <input ref={fileInputRef} type="file" accept="image/*,video/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { if (f.type.startsWith('video/')) uploadAndSave(f, f.name, 'video', `vid_${Date.now()}`); else handlePhotoCapture('file', f) }; e.target.value = '' }} />

      {!cameraReady && (
        <div style={s.noCamera}>
          <span style={{ fontSize: 48 }}>📷</span>
          <span style={{ color: '#888' }}>{errorMsg || 'Starting camera…'}</span>
          <button onClick={() => fileInputRef.current?.click()}
            style={{ marginTop: 8, padding: '10px 24px', borderRadius: 8, background: '#fff', color: '#000', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
            Pick from Library
          </button>
        </div>
      )}

      {/* Recording timer */}
      {isRecording && (
        <div style={s.recBadge}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff3b30', display: 'inline-block', animation: 'pulse 1s infinite' }} />
          {fmtSecs(recordingSecs)}
        </div>
      )}

      {/* Status bar */}
      {status !== 'idle' && (
        <div style={s.statusBar}>
          <div style={dotStyle(status === 'error')} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {statusMsg || errorMsg}
          </span>
        </div>
      )}

      {/* Today's gallery */}
      {showGallery && (
        <div style={s.overlay}>
          <div style={s.overlayHeader}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17 }}>Today's Files</div>
              <div style={{ color: '#555', fontSize: 12, marginTop: 2 }}>
                {todayPhotos.length} file{todayPhotos.length !== 1 ? 's' : ''} · {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
              </div>
            </div>
            <button onClick={() => setShowGallery(false)}
              style={{ background: 'none', border: 'none', color: '#fff', fontSize: 26, cursor: 'pointer', lineHeight: 1 }}>✕</button>
          </div>
          {todayPhotos.length === 0
            ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#444' }}>
                <span style={{ fontSize: 48 }}>📭</span>
                <span>No files taken today yet</span>
              </div>
            : <div style={s.grid}>
                {todayPhotos.map(photo => (
                  <div key={photo.id} style={s.photoCard} onClick={() => setSelectedPhoto(photo)}>
                    {photo.type === 'video'
                      ? <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', flexDirection: 'column', gap: 6 }}>
                          <span style={{ fontSize: 32 }}>🎬</span>
                          <span style={{ fontSize: 11, color: '#555' }}>{photo.filename.split('.').pop()?.toUpperCase()}</span>
                        </div>
                      : <img src={photo.url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                    }
                    {/* Cloud/local badge */}
                    <div style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.7)', borderRadius: 6, padding: '2px 6px', fontSize: 10, color: '#fff' }}>
                      {photo.savedLocally ? '📥' : '☁️'}
                    </div>
                    {/* Delete button */}
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(photo) }}
                      style={{ position: 'absolute', top: 6, left: 6, width: 26, height: 26, borderRadius: '50%', background: 'rgba(0,0,0,0.7)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#ff4444' }}
                    >✕</button>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent,rgba(0,0,0,0.7))', padding: '12px 8px 6px', fontSize: 11, color: '#ccc' }}>
                      {new Date(photo.takenAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                ))}
              </div>
          }
          {/* Send test email footer */}
          <div style={{ flexShrink: 0, padding: '12px 16px', borderTop: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {emailMsg && (
              <div style={{ fontSize: 13, textAlign: 'center', color: emailStatus === 'error' ? '#ff4444' : emailStatus === 'sent' ? '#4ade80' : '#aaa' }}>
                {emailMsg}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={sendTestEmail}
                disabled={emailStatus === 'sending'}
                style={{ flex: 1, padding: '12px', borderRadius: 10, background: emailStatus === 'sending' ? '#1a1a1a' : '#0f2a1a', color: emailStatus === 'sending' ? '#555' : '#4ade80', border: '1px solid #1a4a2a', cursor: emailStatus === 'sending' ? 'default' : 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                {emailStatus === 'sending' ? '⏳ Sending…' : '✉️ Send Test Email'}
              </button>
              <button
                onClick={() => { setShowGallery(false); openManager() }}
                style={{ flex: 1, padding: '12px', borderRadius: 10, background: '#1a1a2e', color: '#7b8cde', border: '1px solid #2a2a4e', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                ☁️ Manage All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cloud Photo Manager */}
      {showManager && (
        <div style={{ ...s.overlay, zIndex: 65 }}>
          <div style={s.overlayHeader}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17 }}>Manage Cloud Photos</div>
              <div style={{ color: '#555', fontSize: 12, marginTop: 2 }}>
                {managerLoading ? 'Loading…' : `${cloudPhotos.length} photos in Supabase`}
                {selected.size > 0 && <span style={{ color: '#ff4444' }}> · {selected.size} selected</span>}
              </div>
            </div>
            <button onClick={() => setShowManager(false)}
              style={{ background: 'none', border: 'none', color: '#fff', fontSize: 26, cursor: 'pointer', lineHeight: 1 }}>✕</button>
          </div>

          {/* Select all / clear row */}
          {!managerLoading && cloudPhotos.length > 0 && (
            <div style={{ flexShrink: 0, padding: '8px 16px', display: 'flex', gap: 8, borderBottom: '1px solid #1a1a1a' }}>
              <button onClick={selectAll} style={{ padding: '6px 14px', borderRadius: 8, background: '#1a1a1a', color: '#aaa', border: '1px solid #333', cursor: 'pointer', fontSize: 13 }}>Select All</button>
              <button onClick={clearSelection} style={{ padding: '6px 14px', borderRadius: 8, background: '#1a1a1a', color: '#aaa', border: '1px solid #333', cursor: 'pointer', fontSize: 13 }}>Clear</button>
              <div style={{ flex: 1 }} />
              <div style={{ fontSize: 12, color: '#444', alignSelf: 'center' }}>Tap to select</div>
            </div>
          )}

          {managerLoading
            ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', flexDirection: 'column', gap: 12 }}>
                <span style={{ fontSize: 32 }}>⏳</span>
                <span>Loading from Supabase…</span>
              </div>
            : managerError
              ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff4444', flexDirection: 'column', gap: 12, padding: 20, textAlign: 'center' }}>
                  <span style={{ fontSize: 32 }}>⚠️</span>
                  <span>{managerError}</span>
                </div>
              : cloudPhotos.length === 0
                ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', flexDirection: 'column', gap: 12 }}>
                    <span style={{ fontSize: 48 }}>☁️</span>
                    <span>No photos in Supabase yet</span>
                  </div>
                : <div style={s.grid}>
                    {cloudPhotos.map(photo => {
                      const isSelected = selected.has(photo.id)
                      return (
                        <div key={photo.id}
                          onClick={() => selected.size > 0 ? toggleSelect(photo.id) : setCloudPreview(photo)}
                          onContextMenu={e => { e.preventDefault(); toggleSelect(photo.id) }}
                          style={{ ...s.photoCard, outline: isSelected ? '3px solid #ff4444' : 'none', outlineOffset: -3 }}>
                          {photo.type === 'video'
                            ? <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', flexDirection: 'column', gap: 6 }}>
                                <span style={{ fontSize: 28 }}>🎬</span>
                              </div>
                            : <img src={photo.url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" loading="lazy"
                                onError={e => { (e.target as HTMLImageElement).style.opacity = '0.2' }} />
                          }
                          {/* Checkmark / select circle */}
                          <div
                            onClick={e => { e.stopPropagation(); toggleSelect(photo.id) }}
                            style={{ position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: '50%', background: isSelected ? '#ff4444' : 'rgba(0,0,0,0.55)', border: `2px solid ${isSelected ? '#ff4444' : 'rgba(255,255,255,0.4)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff' }}>
                            {isSelected ? '✓' : ''}
                          </div>
                          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent,rgba(0,0,0,0.75))', padding: '10px 6px 5px', fontSize: 10, color: '#ccc' }}>
                            {new Date(photo.taken_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {new Date(photo.taken_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
          }

          {/* Delete footer */}
          {selected.size > 0 && (
            <div style={{ flexShrink: 0, padding: '12px 16px', borderTop: '1px solid #1a1a1a' }}>
              <button
                onClick={deleteSelected}
                disabled={deleting}
                style={{ width: '100%', padding: '14px', borderRadius: 10, background: deleting ? '#1a0000' : '#3a0000', color: deleting ? '#555' : '#ff4444', border: '1px solid #5a0000', cursor: deleting ? 'default' : 'pointer', fontWeight: 700, fontSize: 15 }}
              >
                {deleting ? '⏳ Deleting…' : `🗑 Permanently Delete ${selected.size} Photo${selected.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Cloud Photo Fullscreen Preview */}
      {cloudPreview && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 80, display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <div style={{ flexShrink: 0, padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)' }}>
            <div style={{ fontSize: 13, color: '#888' }}>
              {new Date(cloudPreview.taken_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              {' · '}
              {new Date(cloudPreview.taken_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </div>
            <button onClick={() => setCloudPreview(null)}
              style={{ background: 'none', border: 'none', color: '#fff', fontSize: 26, cursor: 'pointer', lineHeight: 1 }}>✕</button>
          </div>

          {/* Image / Video */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {cloudPreview.type === 'video'
              ? <video src={cloudPreview.url} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              : <img src={cloudPreview.url} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} alt="" />
            }
          </div>

          {/* Action buttons */}
          <div style={{ flexShrink: 0, padding: '16px 20px 36px', display: 'flex', gap: 10, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)' }}>
            <button
              onClick={() => shareCloudPhoto(cloudPreview)}
              style={{ flex: 1, padding: '13px', borderRadius: 10, background: '#fff', color: '#000', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
              📤 Share / Save
            </button>
            <button
              onClick={() => { toggleSelect(cloudPreview.id); setCloudPreview(null) }}
              style={{ flex: 1, padding: '13px', borderRadius: 10, background: '#1a1a1a', color: '#aaa', border: '1px solid #333', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
              ☑ Select
            </button>
            <button
              onClick={() => deleteCloudPhoto(cloudPreview)}
              style={{ flex: 1, padding: '13px', borderRadius: 10, background: '#3a0000', color: '#ff4444', border: '1px solid #5a0000', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
              🗑 Delete
            </button>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {selectedPhoto && (
        <div style={s.lightbox} onClick={() => setSelectedPhoto(null)}>
          {selectedPhoto.type === 'video'
            ? <video src={selectedPhoto.url} controls style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 10 }} onClick={e => e.stopPropagation()} />
            : <img src={selectedPhoto.url} style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 10, objectFit: 'contain' }} alt="" />
          }
          <div style={{ display: 'flex', gap: 12 }} onClick={e => e.stopPropagation()}>
            <button onClick={() => handleDownload(selectedPhoto)}
              style={{ padding: '10px 20px', borderRadius: 8, background: '#fff', color: '#000', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
              {(typeof window !== 'undefined' && 'share' in navigator) ? '📤 Share / Save' : '📥 Download'}
            </button>
            <button onClick={() => handleDelete(selectedPhoto)}
              style={{ padding: '10px 20px', borderRadius: 8, background: '#3a0000', color: '#ff4444', border: '1px solid #5a0000', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
              🗑 Delete
            </button>
            <button onClick={() => setSelectedPhoto(null)}
              style={{ padding: '10px 20px', borderRadius: 8, background: '#222', color: '#fff', border: '1px solid #333', cursor: 'pointer', fontSize: 14 }}>
              Close
            </button>
          </div>
          <div style={{ color: '#555', fontSize: 12 }}>
            {selectedPhoto.savedLocally ? '📥 Saved locally' : '☁️ Uploaded'} · {new Date(selectedPhoto.takenAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>
      )}

      {cameraReady && (
        <>
          {/* PHOTO / VIDEO mode switcher */}
          <div style={s.modeBar}>
            <div style={{ display: 'flex', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(16px)', borderRadius: 30, padding: 3, border: '1px solid rgba(255,255,255,0.2)' }}>
              <button style={modeBtn(captureMode === 'photo')} onClick={() => { if (!isRecording) setCaptureMode('photo') }}>PHOTO</button>
              <button style={modeBtn(captureMode === 'video')} onClick={() => { if (!isRecording) setCaptureMode('video') }}>VIDEO</button>
            </div>
          </div>

          <div style={s.controls}>
            {/* Today's files */}
            <div style={{ position: 'relative' }}>
              <button style={s.iconBtn} onClick={() => setShowGallery(true)}>🗂</button>
              {todayPhotos.length > 0 && (
                <div style={{ position: 'absolute', top: -4, right: -4, background: '#4ade80', color: '#000', borderRadius: '50%', width: 18, height: 18, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {todayPhotos.length > 9 ? '9+' : todayPhotos.length}
                </div>
              )}
            </div>

            {/* Shutter / Record */}
            <button style={shutterStyle(isRecording)} onClick={handleShutter} disabled={isBusy}>
              {captureMode === 'photo'
                ? (status !== 'idle'
                    ? <span style={{ fontSize: 22 }}>⏳</span>
                    : <span style={{ width: 56, height: 56, borderRadius: '50%', background: '#fff', display: 'block' }} />)
                : (isRecording
                    ? <span style={{ width: 22, height: 22, borderRadius: 4, background: '#fff', display: 'block' }} />
                    : <span style={{ width: 56, height: 56, borderRadius: '50%', background: '#ff3b30', display: 'block' }} />)
              }
            </button>

            <button style={s.iconBtn} onClick={flipCamera} disabled={isRecording}>🔄</button>
          </div>
        </>
      )}

      {!cameraReady && (
        <div style={{ ...s.controls, justifyContent: 'center', gap: 20 }}>
          <button style={s.iconBtn} onClick={() => setShowGallery(true)}>🗂</button>
          <button style={{ ...shutterStyle(false), background: '#333' }} onClick={() => fileInputRef.current?.click()}>
            <span style={{ fontSize: 28 }}>📁</span>
          </button>
          <div style={{ width: 48 }} />
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button:active { transform: scale(0.93); }
      `}</style>
    </div>
  )
}
