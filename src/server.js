// Maxine Walkthrough Worker — HTTP layer
// POST /process  : kick off decomposition of one walkthrough video (async, 202)
// GET  /health   : liveness check for Railway
//
// Auth: every /process call must carry header  x-worker-secret: <WORKER_SHARED_SECRET>
// The worker responds 202 immediately, runs the pipeline in the background,
// then POSTs the result to callback_url (your n8n webhook) when done.

import express from "express";
import { processWalkthrough } from "./pipeline.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "WORKER_SHARED_SECRET",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/process", (req, res) => {
  if (req.header("x-worker-secret") !== process.env.WORKER_SHARED_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const {
    session_id,        // intake_sessions id this walkthrough belongs to
    bucket = "walkthroughs",
    video_path,        // Storage path of the uploaded video, e.g. "raw/abc123.mp4"
    callback_url,      // n8n webhook to notify on completion (optional)
    max_frames = 40,   // hard cap on frames kept in the timeline
    interval_s = 2.5,  // baseline sampling interval
    transcribe_model = "whisper-1", // whisper-1 = segment timestamps via verbose_json
  } = req.body || {};

  if (!session_id || !video_path) {
    return res.status(400).json({ error: "session_id and video_path are required" });
  }

  // Acknowledge immediately; a 10-min video takes ~30-60s to process.
  res.status(202).json({ accepted: true, session_id });

  processWalkthrough({
    sessionId: session_id,
    bucket,
    videoPath: video_path,
    callbackUrl: callback_url,
    maxFrames: Math.min(Number(max_frames) || 40, 80),
    intervalS: Number(interval_s) || 2.5,
    transcribeModel: transcribe_model,
  }).catch((err) => {
    // processWalkthrough handles its own callback/error reporting;
    // this catch is a last-resort log so the process never crashes.
    console.error(`[${session_id}] unhandled pipeline error:`, err);
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`walkthrough-worker listening on :${port}`));
