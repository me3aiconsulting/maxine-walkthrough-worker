// Maxine Walkthrough Worker — stage 2: interpretation
// timeline.json + frames  ->  LLM (OpenAI or Anthropic)  ->  provenance-tagged job dossier
// Provider-neutral by design: the "provider" job field is the bake-off switch.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ------------------------------------------------------------ system prompt

const SYSTEM_PROMPT = `You are Maxine's walkthrough analyst for LFP Partners, a Metro Atlanta contracting company. You are given a job-site walkthrough as an interleaved timeline: video keyframes and the narrator's transcribed speech, in time order. The narrator is typically the project manager walking a client's property.

Your task is to produce a structured JOB DOSSIER that a human estimator will review before a Scope of Work is written.

PROVENANCE RULES — every fact you record must carry a provenance tag:
- "measured": a dimension shown on camera (tape measure, laser readout) or a specific number spoken aloud ("nine foot ceilings", "about twelve feet of cabinet run")
- "stated": something the narrator explicitly said needs doing or is true, without a measurement
- "observed": something visible in the frames that the narrator did NOT mention (staining, cracks, code issues, materials, fixture types)
- "inferred": work you conclude is necessary from trade knowledge even though it was neither said nor shown

Also assign confidence: "high", "medium", or "low". A spoken approximate number is measured/medium. A clear tape-measure reading is measured/high.

INFERENCE RULES — read between the lines using construction-sequence knowledge:
- Complete the trade chain: tile demo implies backer board, waterproofing, and subfloor inspection; toilet removal implies a new wax ring and flange check; drywall removal near moisture implies insulation inspection; fixture relocation implies plumbing/electrical rough-in.
- Standard scope always applies: site protection/masking, debris removal and haul-off, final cleanup. Include these as inferred work items.
- Flag permit-likely work (structural, electrical, plumbing, additions) — do not decide jurisdiction specifics.
- NEVER let an inferred item hide inside a stated item. Inferred work is always its own entry so the reviewer can strike it.
- When the video is ambiguous (can't tell if a wall is load-bearing, can't read a measurement, unclear material), do NOT guess. Record it in open_questions instead.

REVIEW FLAGS — set requires_human_review true and list reasons when you see: structural work, possible mold/asbestos-era materials, insufficient detail to scope, or anything the narrator asked to double-check.

OUTPUT FORMAT — respond with ONLY a JSON object, no markdown fences, no preamble, matching exactly this shape:
{
  "version": 1,
  "project_summary": "2-4 sentence plain-language summary of the property area(s) and requested work",
  "areas": [
    {
      "name": "Kitchen",
      "observations": [
        { "fact": "...", "provenance": "measured|stated|observed|inferred", "confidence": "high|medium|low", "timestamp_s": 12.5 }
      ]
    }
  ],
  "measurements": [
    { "item": "ceiling height", "value": "9 ft", "area": "Kitchen", "provenance": "measured", "confidence": "medium", "timestamp_s": 34.0 }
  ],
  "work_items": [
    { "area": "Kitchen", "trade": "drywall", "description": "...", "provenance": "stated|observed", "confidence": "high|medium|low", "timestamp_s": 51.0 }
  ],
  "implied_work_items": [
    { "area": "Kitchen", "trade": "plumbing", "description": "...", "reason": "why trade knowledge requires this", "depends_on": "the stated item that triggers it" }
  ],
  "open_questions": [ "..." ],
  "requires_human_review": false,
  "review_reasons": []
}

timestamp_s is the timeline time (seconds) where the fact appears; use the nearest event time. Use null when a fact has no single timestamp. Be exhaustive on observations but never invent details the frames and transcript do not support.`;

// ---------------------------------------------------------------- entrypoint

export async function interpretWalkthrough(job) {
  const { sessionId, bucket, callbackUrl } = job;
  const log = (...a) => console.log(`[interpret ${sessionId}]`, ...a);

  try {
    // 1. Load the capture row + timeline
    const { data: row, error: rowErr } = await supabase
      .from("walkthrough_captures").select("timeline_path,status").eq("session_id", sessionId).single();
    if (rowErr || !row?.timeline_path) throw new Error(`no ready capture for session (${rowErr?.message || "missing timeline_path"})`);

    const timeline = JSON.parse(await downloadText(bucket, row.timeline_path));
    log(`timeline loaded: ${timeline.events.length} events`);

    // 2. Build interleaved multimodal content (frames as base64, speech as text)
    const { content, frameCount } = await buildContent(bucket, timeline, job.maxFrames);
    log(`content built: ${frameCount} frames included`);

    // 3. Call the selected provider
    const raw = job.provider === "anthropic"
      ? await callAnthropic(content, job.model || "claude-sonnet-4-6")
      : await callOpenAI(content, job.model || "gpt-4o");
    const dossier = parseJson(raw);
    dossier._meta = {
      provider: job.provider, model: job.model || (job.provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o"),
      frames_sent: frameCount, interpreted_at: new Date().toISOString(),
    };
    log(`dossier parsed: ${dossier.work_items?.length ?? 0} work items, ${dossier.implied_work_items?.length ?? 0} implied`);

    // 4. Persist + notify
    await supabase.from("walkthrough_captures")
      .update({ dossier, status: "interpreted", error: null, updated_at: new Date().toISOString() })
      .eq("session_id", sessionId);

    await notify(callbackUrl, {
      session_id: sessionId, status: "interpreted",
      provider: dossier._meta.provider, model: dossier._meta.model,
      work_items: dossier.work_items?.length ?? 0,
      implied_work_items: dossier.implied_work_items?.length ?? 0,
      open_questions: dossier.open_questions?.length ?? 0,
      requires_human_review: !!dossier.requires_human_review,
      dossier,
    });
    log("done");
  } catch (err) {
    console.error(`[interpret ${sessionId}] failed:`, err.message);
    await supabase.from("walkthrough_captures")
      .update({ error: `interpret: ${String(err.message).slice(0, 480)}`, updated_at: new Date().toISOString() })
      .eq("session_id", sessionId).then(() => {}, () => {});
    await notify(callbackUrl, { session_id: sessionId, status: "interpret_error", error: String(err.message) }).catch(() => {});
  }
}

// --------------------------------------------------------- content assembly

async function buildContent(bucket, timeline, maxFrames = 40) {
  const frames = timeline.events.filter((e) => e.type === "frame").slice(0, maxFrames);
  const framePaths = new Set(frames.map((f) => f.storage_path));

  const parts = [{
    kind: "text",
    text: `Walkthrough duration: ${timeline.duration_s}s. Source: ${timeline.source?.kind || "video"}. The following is the interleaved timeline. [t=Ns] marks the timeline position of each element.`,
  }];

  for (const ev of timeline.events) {
    if (ev.type === "speech") {
      parts.push({ kind: "text", text: `[t=${ev.t}s] Narrator: "${ev.text}"` });
    } else if (ev.type === "frame" && framePaths.has(ev.storage_path)) {
      parts.push({ kind: "text", text: `[t=${ev.t}s] Frame:` });
      parts.push({ kind: "image", b64: await downloadB64(bucket, ev.storage_path) });
    }
  }
  parts.push({ kind: "text", text: "Produce the job dossier JSON now." });
  return { content: parts, frameCount: frames.length };
}

// ------------------------------------------------------------- provider calls

async function callOpenAI(parts, model) {
  const content = parts.map((p) => p.kind === "image"
    ? { type: "image_url", image_url: { url: `data:image/jpeg;base64,${p.b64}` } }
    : { type: "text", text: p.text });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      max_tokens: 8000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(parts, model) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set — add it in Railway Variables to use provider=anthropic");
  const content = parts.map((p) => p.kind === "image"
    ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.b64 } }
    : { type: "text", text: p.text });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// -------------------------------------------------------------------- utils

function parseJson(raw) {
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch {
    const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("model did not return parseable JSON");
  }
}

async function downloadText(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw new Error(`storage download failed (${path}): ${error.message}`);
  return await data.text();
}

async function downloadB64(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw new Error(`storage download failed (${path}): ${error.message}`);
  return Buffer.from(await data.arrayBuffer()).toString("base64");
}

async function notify(callbackUrl, payload) {
  if (!callbackUrl) return;
  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`interpret callback returned ${res.status}`);
}
