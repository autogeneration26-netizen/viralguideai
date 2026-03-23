// ViralGuideAI – AI Content Generator Edge Function
// supabase/functions/generate/index.ts
//
// Required environment variables (set in Supabase Dashboard → Edge Functions → Secrets):
//   GEMINI_API_KEY            – your Google AI Studio API key
//   SUPABASE_URL              – auto-injected by Supabase
//   SUPABASE_SERVICE_ROLE_KEY – auto-injected by Supabase
//   SUPABASE_ANON_KEY         – auto-injected by Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function callGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY")!;
  const url    = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.85, maxOutputTokens: 1200 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini.");
  return text.trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing Authorization header." }, 401);

  // Verify Supabase JWT
  const sbAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: authError } = await sbAuth.auth.getUser();
  if (authError || !user) return json({ error: "Unauthorized." }, 401);

  const uid   = user.id;
  const email = user.email ?? "";

  let body: { topic?: string; platform?: string; audience?: string; language?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const { topic, platform, audience, language } = body;
  if (!topic || !platform || !audience || !language)
    return json({ error: "Missing required fields." }, 400);

  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Upsert user on first sign-in
  await sbAdmin.from("users").upsert({ id: uid, email }, { onConflict: "id", ignoreDuplicates: true });

  const { data: userData, error: fetchErr } = await sbAdmin
    .from("users")
    .select("plan_tier, monthly_credits, daily_credits_used, last_generation_date")
    .eq("id", uid)
    .single();

  if (fetchErr || !userData) return json({ error: "Could not retrieve user data." }, 500);

  const today = new Date().toISOString().split("T")[0];

  if (userData.plan_tier === "free") {
    let dailyUsed = userData.daily_credits_used;
    if (userData.last_generation_date !== today) {
      dailyUsed = 0;
      await sbAdmin.from("users").update({ daily_credits_used: 0 }).eq("id", uid);
    }
    if (dailyUsed >= 5) return json({ error: "Daily limit reached. Upgrade for more strategies." }, 403);
  } else {
    if (userData.monthly_credits < 1) return json({ error: "Monthly credit limit reached. Please upgrade." }, 403);
  }

  const systemPrompt = `You are an elite social media strategist with a decade of experience creating viral content that generates millions of views. Your specialty is reverse-engineering what makes content spread and combining that with audience psychology, platform algorithms, and monetization principles.

CRITICAL INSTRUCTION: You MUST write every single word of your response in ${language}. Do not use any other language. This includes all labels, headers, and content.

Generate a complete, ready-to-use viral content strategy. Be specific, actionable, and data-driven. No filler words. No generic advice. Every line must deliver immediate, implementable value.

Structure your response EXACTLY as follows (in ${language}):

🎣 HOOK
[One irresistible opening line that stops the scroll. Under 15 words.]

📜 SCRIPT
[A concise, punchy script outline with opening, body, and CTA. 100–150 words max.]

✍️ CAPTION
[A platform-optimized caption with emotional hook, value statement, and call to action. 60–80 words.]

#️⃣ HASHTAGS
[12–15 highly relevant hashtags, mix of broad, niche, and trending.]

🔥 VIRAL SCORE
[Score out of 100. Break down: Shareability X/25 · Emotional Impact X/25 · Trend Alignment X/25 · Audience Fit X/25. One sentence explanation per dimension.]

💰 MONETIZATION STRATEGY
[3 specific, concrete monetization angles for this exact content piece. Be direct and tactical.]`;

  let strategy: string;
  try {
    strategy = await callGemini(systemPrompt, `Platform: ${platform}\nTopic: ${topic}\nAudience: ${audience}\nOutput Language: ${language}`);
  } catch (err) {
    console.error("Gemini error:", err);
    return json({ error: "AI generation failed. Please try again." }, 500);
  }

  if (userData.plan_tier === "free") {
    const newDaily = (userData.last_generation_date === today ? userData.daily_credits_used : 0) + 1;
    await sbAdmin.from("users").update({ daily_credits_used: newDaily, last_generation_date: today }).eq("id", uid);
  } else {
    await sbAdmin.from("users").update({ monthly_credits: userData.monthly_credits - 1, last_generation_date: today }).eq("id", uid);
  }

  return json({ strategy }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
