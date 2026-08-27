// Maxine Walkthrough Worker — stage 3: SOW draft
// dossier (from walkthrough_captures)  ->  LLM  ->  client-ready draft Scope of Work (markdown)
// Text-only call: cheap, fast, no images.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const SOW_SYSTEM_PROMPT = `You are Maxine, the internal Estimator Agent for LFP Partners LLC (Stone Mountain, GA — Metro Atlanta contracting). You are given a structured job dossier produced from a site walkthrough video. Write a DRAFT Scope of Work in LFP Partners' house style for internal review by Anthony Reid before it is sent to a client.

LFP SOW STYLE — follow exactly:
- Numbered line items, one per major work area or trade package (e.g. "1. Master Bathroom Renovation").
- Under each line item: "Scope of Work:" followed by bullet points starting with "•".
- Bullets are complete, professional sentences in imperative form ("Demo existing tub...", "Install new porcelain tile...").
- Each line item begins with protection/prep where relevant and ends with cleanup/debris removal/walkthrough where relevant.
- Professional, factual, measured tone. Never sales-oriented. No pricing anywhere.

DOSSIER-TO-SOW RULES:
- Facts tagged "stated" or "measured" become firm scope language.
- Facts tagged "observed" may be included where clearly work-relevant, phrased factually.
- Items from implied_work_items MUST appear, but each such bullet ends with the marker " (inferred — verify)". Never blend inferred work invisibly into stated scope.
- Use measurements from the dossier verbatim, noting approximation where confidence is not high (e.g. "approx. 12' x 5.5'").
- After the numbered line items, add a section "Open Items Requiring Client/PM Confirmation" listing every open_question plus any low-confidence assumption you relied on.
- If requires_human_review is true, add a final section "Internal Review Flags" listing review_reasons. This section is internal and marked as such.
- End with a one-line note: "Draft generated from walkthrough capture — pending review. Standard LFP Partners exclusions and assumptions apply."

Output clean markdown. No preamble, no commentary — the document only.`;

export async function generateSow(job) {
  const { sessionId, callbackUrl } = job;
  const log = (...a) => console.log(`[sow ${sessionId}]`, ...a);

  try {
    const { data: row, error: rowErr } = await supabase
      .from("walkthrough_captures").select("dossier,status").eq("session_id", sessionId).single();
    if (rowErr || !row?.dossier) throw new Error(`no dossier for session (${rowErr?.message || "dossier is null"})`);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: job.model || "gpt-4o",
        max_tokens: 4000,
        messages: [
          { role: "system", content: SOW_SYSTEM_PROMPT },
          { role: "user", content: `Job dossier JSON:\n${JSON.stringify(row.dossier, null, 2)}\n\nWrite the draft Scope of Work now.` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const sow = (data.choices?.[0]?.message?.content || "").trim();
    if (!sow) throw new Error("model returned empty SOW");
    log(`SOW drafted: ${sow.length} chars`);

    await supabase.from("walkthrough_captures")
      .update({ sow_draft: sow, status: "sow_drafted", error: null, updated_at: new Date().toISOString() })
      .eq("session_id", sessionId);

    await notify(callbackUrl, {
      session_id: sessionId, status: "sow_drafted",
      sow_chars: sow.length,
      sow_preview: sow.slice(0, 400),
    });
    log("done");
  } catch (err) {
    console.error(`[sow ${sessionId}] failed:`, err.message);
    await supabase.from("walkthrough_captures")
      .update({ error: `sow: ${String(err.message).slice(0, 480)}`, updated_at: new Date().toISOString() })
      .eq("session_id", sessionId).then(() => {}, () => {});
    await notify(callbackUrl, { session_id: sessionId, status: "sow_error", error: String(err.message) }).catch(() => {});
  }
}

async function notify(callbackUrl, payload) {
  if (!callbackUrl) return;
  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`sow callback returned ${res.status}`);
}
