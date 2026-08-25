# Maxine Walkthrough Worker

Video decomposition worker for Maxine's walkthrough-capture pipeline. Receives a webhook when a walkthrough video lands in Supabase Storage, then:

1. Downloads the video and extracts a small mono audio track (ffmpeg)
2. Extracts keyframes — fixed-interval sampling (every 2.5s) **plus** scene-change detection, merged, deduped, capped at 40
3. Transcribes the audio via OpenAI (`whisper-1`, `verbose_json` for segment timestamps)
4. Interleaves frames + speech segments into a single timestamped `timeline.json`
5. Uploads frames + timeline to Storage, upserts a `walkthrough_captures` row, and POSTs a completion callback to your n8n webhook

The worker does **not** call the interpretation LLM — that is stage 2, behind the provider-neutral `interpret-walkthrough` abstraction, and stays swappable (Claude / GPT bake-off).

---

## 1. One-time setup

**Supabase — Storage bucket.** Create a private bucket named `walkthroughs`.

**Supabase — table.** Apply `migration_walkthrough_captures.sql` (via `Supabase:apply_migration`, name it `create_walkthrough_captures`). Note: it references `intake_sessions(id)` — confirm that column is `uuid` first (per usual `information_schema.columns` check); if your intake ids are text, change the column type before applying.

**n8n — completion webhook.** Create a NEW workflow (frozen-contract: do not touch Workflows A/B) with a Webhook node at a fresh path, e.g. `maxine-walkthrough-complete`. This is the `callback_url` the worker notifies.

## 2. Deploy to Railway

1. Push this folder to a GitHub repo (e.g. `maxine-walkthrough-worker`)
2. Railway → New Project → Deploy from GitHub repo. Railway detects the Dockerfile automatically (ffmpeg is baked into the image)
3. Set environment variables:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://ifetefxunddokuwgwhop.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (Settings → API) — **service role, not anon** |
| `OPENAI_API_KEY` | same key the voice panel uses |
| `WORKER_SHARED_SECRET` | generate one: `openssl rand -hex 24` |

4. Settings → Networking → Generate Domain. You'll get `https://<app>.up.railway.app`
5. Verify: `curl https://<app>.up.railway.app/health` → `{"ok":true}`

## 3. API contract

**POST `/process`** — header `x-worker-secret: <WORKER_SHARED_SECRET>`

```json
{
  "session_id": "<intake_sessions uuid>",
  "bucket": "walkthroughs",
  "video_path": "raw/<session_id>.mp4",
  "callback_url": "https://risinai.app.n8n.cloud/webhook/maxine-walkthrough-complete",
  "max_frames": 40,
  "interval_s": 2.5
}
```

Responds `202` immediately; a 10-minute video finishes in roughly 30–60s. Completion callback:

```json
{
  "session_id": "…", "status": "ready", "bucket": "walkthroughs",
  "timeline_path": "sessions/<session_id>/timeline.json",
  "frame_count": 38, "duration_s": 612
}
```

On failure, `status: "error"` with an `error` message, and the DB row is marked `error`.

**Outputs in Storage** (bucket `walkthroughs`):
- `sessions/<session_id>/frames/t000012.5.jpg` … (1024px-wide JPEGs, timestamp in filename)
- `sessions/<session_id>/timeline.json`

**timeline.json shape** — this is exactly what the stage-2 interpretation call consumes:

```json
{
  "version": 1,
  "session_id": "…",
  "source": { "kind": "phone_video", "video_path": "raw/….mp4" },
  "duration_s": 612.4,
  "events": [
    { "type": "frame",  "t": 0,    "storage_path": "sessions/…/frames/t000000.0.jpg", "source": "interval" },
    { "type": "speech", "t": 1.2,  "t_end": 6.8, "text": "Okay so this is the garage ceiling…" },
    { "type": "frame",  "t": 2.5,  "storage_path": "…", "source": "scene" }
  ]
}
```

## 4. Wiring into the stack (all new, parallel paths)

```
Lovable app ──upload──▶ Storage: walkthroughs/raw/{session_id}.mp4
      │
      └─▶ new edge function `start-walkthrough` (or n8n HTTP node)
              POST worker /process  (with shared secret + callback_url)
                          │
                          ▼
              worker: ffmpeg → Whisper → timeline.json → walkthrough_captures row
                          │
                          ▼
      n8n webhook `maxine-walkthrough-complete`
              → stage 2: interpret-walkthrough (LLM call, provider-neutral)
              → dossier → converges on same SOW-generation handoff as voice/text intake
```

Reminders from prior sessions that apply here: disable JWT verification on any new edge function after deploying it (defaults to on → misleading CORS/401s), and the callback webhook is a **new** path — never reuse Workflow A/B paths.

## 5. Smoke test (before any UI exists)

Upload any short phone video to the bucket as `raw/test.mp4`, then:

```bash
curl -X POST https://<app>.up.railway.app/process \
  -H "Content-Type: application/json" \
  -H "x-worker-secret: $WORKER_SHARED_SECRET" \
  -d '{
    "session_id": "<an existing intake_sessions uuid>",
    "video_path": "raw/test.mp4",
    "callback_url": "https://risinai.app.n8n.cloud/webhook-test/maxine-walkthrough-complete"
  }'
```

Then check: `walkthrough_captures` row is `ready`, `timeline.json` exists in Storage, and the n8n test webhook received the callback.

## 6. Cost & limits notes

- Whisper: $0.006/min → ~$0.06 per 10-min walkthrough. Swap `transcribe_model` later if desired; `whisper-1` is used because `verbose_json` segment timestamps are required for interleaving.
- Audio is re-encoded to 32kbps mono (≈2.4MB per 10 min), safely under the 25MB API cap. Videos over ~1.5 hours would need chunking — not implemented, flag if that ever becomes real.
- Railway hobby tier (~$5/mo) comfortably handles several walkthroughs/day; jobs run sequentially in-process. If volume grows for the SaaS layer, add a queue (pg-boss on your existing Postgres) before scaling instances.
- Recording consent: capture UI must include the consent step (Georgia one-party; white-label tenants vary by state).
