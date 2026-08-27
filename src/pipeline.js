// Maxine Walkthrough Worker — pipeline
// video in Storage  ->  frames + audio (ffmpeg)  ->  transcript (Whisper)
//                   ->  interleaved timeline.json  ->  Storage + walkthrough_captures row
//                   ->  callback to n8n

import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------------------------------------------------------------- entrypoint

export async function processWalkthrough(job) {
  const { sessionId, bucket, videoPath, callbackUrl } = job;
  const work = await mkdtemp(path.join(tmpdir(), "walk-"));
  const log = (...a) => console.log(`[${sessionId}]`, ...a);

  try {
    await upsertCapture(sessionId, { video_path: videoPath, status: "processing", error: null });

    // 1. Pull the raw video down from Storage
    const videoFile = path.join(work, "input" + path.extname(videoPath || ".mp4"));
    await downloadFromStorage(bucket, videoPath, videoFile);
    const durationS = await probeDuration(videoFile);
    log(`downloaded video, duration ${durationS.toFixed(1)}s`);

    // 2. Extract a small mono audio track (keeps a 10-min video well under the 25MB API cap)
    const audioFile = path.join(work, "audio.mp3");
    await exec("ffmpeg", ["-y", "-i", videoFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audioFile]);

    // 3. Extract frames: baseline interval sampling + scene-change detection, then merge
    const frames = await extractFrames(videoFile, work, job.intervalS, job.maxFrames, durationS, log);

    // 4. Transcribe (whisper-1 verbose_json = segment-level timestamps)
    const segments = await transcribe(audioFile, job.transcribeModel);
    log(`transcribed: ${segments.length} segments`);

    // 5. Upload frames to Storage
    const prefix = `sessions/${sessionId}`;
    for (const f of frames) {
      f.storage_path = `${prefix}/frames/t${f.t.toFixed(1).padStart(6, "0")}.jpg`;
      await uploadToStorage(bucket, f.storage_path, await readFile(f.file), "image/jpeg");
    }
    log(`uploaded ${frames.length} frames`);

    // 6. Build the interleaved timeline — the exact structure the interpretation call consumes
    const timeline = buildTimeline({ sessionId, videoPath, durationS, frames, segments });
    const timelinePath = `${prefix}/timeline.json`;
    await uploadToStorage(bucket, timelinePath, Buffer.from(JSON.stringify(timeline, null, 2)), "application/json");

    await upsertCapture(sessionId, {
      status: "ready",
      timeline_path: timelinePath,
      duration_s: Math.round(durationS),
      frame_count: frames.length,
      transcript_chars: segments.reduce((n, s) => n + s.text.length, 0),
    });

    await notify(callbackUrl, {
      session_id: sessionId, status: "ready", bucket,
      timeline_path: timelinePath, frame_count: frames.length,
      duration_s: Math.round(durationS),
    });
    log("done");
  } catch (err) {
    console.error(`[${sessionId}] pipeline failed:`, err.message);
    await upsertCapture(sessionId, { status: "error", error: String(err.message).slice(0, 500) }).catch(() => {});
    await notify(callbackUrl, { session_id: sessionId, status: "error", error: String(err.message) }).catch(() => {});
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- ffmpeg

async function probeDuration(file) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("could not read video duration");
  return d;
}

async function extractFrames(videoFile, work, intervalS, maxFrames, durationS, log) {
  // Pass A: fixed-interval sampling (never misses slow pans)
  const intDir = path.join(work, "int");
  await exec("mkdir", ["-p", intDir]);
  await exec("ffmpeg", ["-y", "-i", videoFile,
    "-vf", `fps=1/${intervalS},scale=1024:-2`, "-q:v", "3",
    path.join(intDir, "f_%05d.jpg"),
  ]);
  const intFiles = (await readdir(intDir)).sort();
  const interval = intFiles.map((name, i) => ({
    t: +(i * intervalS).toFixed(2),
    file: path.join(intDir, name),
    source: "interval",
  }));

  // Pass B: scene-change detection (catches room transitions between samples)
  const sceneDir = path.join(work, "scene");
  const sceneMeta = path.join(work, "scenes.txt");
  await exec("mkdir", ["-p", sceneDir]);
  await exec("ffmpeg", ["-y", "-i", videoFile,
    "-vf", `select='gt(scene,0.35)',metadata=print:file=${sceneMeta},scale=1024:-2`,
    "-vsync", "vfr", "-q:v", "3",
    path.join(sceneDir, "s_%05d.jpg"),
  ]).catch(() => {}); // scene pass is best-effort; interval pass is the safety net

  let scene = [];
  try {
    const meta = await readFile(sceneMeta, "utf8");
    const times = [...meta.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]));
    const sceneFiles = (await readdir(sceneDir)).sort();
    scene = sceneFiles.map((name, i) => ({
      t: +(times[i] ?? 0).toFixed(2),
      file: path.join(sceneDir, name),
      source: "scene",
    }));
  } catch { /* no scene changes detected — fine */ }

  // Merge: sort by time, prefer scene frames, drop neighbors within 1.2s, cap evenly
  const merged = [...scene, ...interval].sort((a, b) => a.t - b.t || (a.source === "scene" ? -1 : 1));
  const deduped = [];
  for (const f of merged) {
    if (!deduped.length || f.t - deduped[deduped.length - 1].t >= 1.2) deduped.push(f);
  }
  let kept = deduped;
  if (deduped.length > maxFrames) {
    kept = [];
    const step = deduped.length / maxFrames;
    for (let i = 0; i < maxFrames; i++) kept.push(deduped[Math.floor(i * step)]);
  }
  log(`frames: ${interval.length} interval + ${scene.length} scene -> ${kept.length} kept (cap ${maxFrames})`);
  return kept;
}

// -------------------------------------------------------------- transcription

async function transcribe(audioFile, model) {
  const form = new FormData();
  const bytes = await readFile(audioFile);
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json"); // gives segment start/end times
  form.append("temperature", "0");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription failed (${res.status}): ${await res.text()}`);
  const data = await res.json();

  return (data.segments || []).map((s) => ({
    t_start: +s.start.toFixed(2),
    t_end: +s.end.toFixed(2),
    text: s.text.trim(),
  })).filter((s) => s.text.length > 0);
}

// ------------------------------------------------------------------ timeline

function buildTimeline({ sessionId, videoPath, durationS, frames, segments }) {
  const events = [
    ...frames.map((f) => ({ type: "frame", t: f.t, storage_path: f.storage_path, source: f.source })),
    ...segments.map((s) => ({ type: "speech", t: s.t_start, t_end: s.t_end, text: s.text })),
  ].sort((a, b) => a.t - b.t);

  return {
    version: 1,
    session_id: sessionId,
    source: { kind: "phone_video", video_path: videoPath }, // CaptureSource adapter tag
    duration_s: +durationS.toFixed(1),
    frame_count: frames.length,
    segment_count: segments.length,
    events,
  };
}

// -------------------------------------------------------------- supabase I/O

async function downloadFromStorage(bucket, storagePath, destFile) {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) throw new Error(`storage download failed: ${error.message}`);
  await writeFile(destFile, Buffer.from(await data.arrayBuffer()));
}

async function uploadToStorage(bucket, storagePath, buffer, contentType) {
  const { error } = await supabase.storage.from(bucket)
    .upload(storagePath, buffer, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed (${storagePath}): ${error.message}`);
}

async function upsertCapture(sessionId, fields) {
  const { error } = await supabase.from("walkthrough_captures")
    .upsert({ session_id: sessionId, ...fields, updated_at: new Date().toISOString() }, { onConflict: "session_id" });
  if (error) console.error(`[${sessionId}] walkthrough_captures upsert failed:`, error.message);
}

async function notify(callbackUrl, payload) {
  if (!callbackUrl) return;
  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`callback to ${callbackUrl} returned ${res.status}`);
}
