/**
 * Ralli AI Insights — Vercel Serverless Function
 *
 * POST /api/ai-insights
 *
 * Accepts structured performance data, generates a natural-language summary
 * and ranked recommendations using OpenAI gpt-4o-mini.
 *
 * If OPENAI_API_KEY is not configured, returns a structured fallback response
 * so the UI degrades gracefully — rules-based recommendations still display,
 * only the prose summary is unavailable.
 *
 * Request body:
 *   {
 *     scope:   'user' | 'team' | 'org'
 *     data:    UserPerformance | TeamInsights | OrgInsights
 *     recs:    Recommendation[]   — rules-based recs from insightsService
 *   }
 *
 * Response:
 *   {
 *     summary:         string
 *     recommendations: Recommendation[]
 *     aiAvailable:     boolean
 *   }
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { scope, data, recs = [] } = req.body ?? {};

  if (!scope || !data) {
    return res.status(400).json({ error: "Missing scope or data" });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  // ── Fallback: no API key configured ─────────────────────────────────────────
  if (!apiKey) {
    return res.status(200).json({
      summary:         null,
      recommendations: recs,
      aiAvailable:     false,
      reason:          "AI summary unavailable — OPENAI_API_KEY not configured",
    });
  }

  // ── Build prompt based on scope ──────────────────────────────────────────────
  let systemPrompt = "";
  let userPrompt   = "";

  if (scope === "user") {
    systemPrompt = `You are a sales readiness coach assistant for Ralli, a sales training platform.
You receive real performance data for a sales rep and write a concise, honest, constructive 2-3 sentence summary of their current readiness.
Do not invent data. Do not use filler phrases like "Great job!" unless the data supports it.
Be specific — reference actual numbers. Tone: direct, supportive, professional.`;

    userPrompt = `Sales rep performance data (last ${data.windowDays ?? 30} days):
- Readiness Score: ${data.score}/100
- Learning: ${data.lessonsCompleted} lessons completed, ${data.coursesCompleted} courses completed
- Quiz: ${data.quizzesAttempted} quizzes attempted, ${data.quizzesPassed} passed, avg score ${data.avgQuizScore}%
- Games: ${data.gamesPlayed} live games played
- Total XP: ${data.totalXp} (${data.recentXp} earned in this window)
- Top recommendations: ${recs.slice(0,3).map(r => r.action).join("; ")}

Write a 2-3 sentence summary of this rep's readiness and what they should focus on next.`;
  }

  else if (scope === "team") {
    systemPrompt = `You are a sales coaching analytics assistant for Ralli, a sales training platform.
You receive team readiness data and write a concise, honest 2-3 sentence summary for a manager.
Do not invent data. Reference actual numbers. Highlight risks and strengths. Tone: direct, managerial.`;

    userPrompt = `Team readiness data:
- Team size: ${data.totalMembers} members
- Average readiness score: ${data.avgScore}/100
- Score distribution: ${data.distribution?.high ?? 0} high, ${data.distribution?.onTrack ?? 0} on track, ${data.distribution?.atRisk ?? 0} at risk
- Members at risk (<65): ${data.atRisk?.length ?? 0}
- Top performers (85+): ${data.topPerformers?.length ?? 0}

Write a 2-3 sentence manager summary of team readiness and the most important action to take.`;
  }

  else if (scope === "org") {
    systemPrompt = `You are an executive analytics assistant for Ralli, a sales training platform.
You receive org-level data and write a concise 2-3 sentence executive summary for an admin.
Do not invent data. Reference actual numbers. Tone: direct, strategic.`;

    userPrompt = `Organization readiness data:
- Active users: ${data.activeUsers} total, ${data.activeUsersLast30} active in last 30 days
- Total XP earned: ${data.totalXp}
- Quiz performance: ${data.totalQuizAttempts} attempts, avg score ${data.orgAvgQuizScore}%, pass rate ${data.orgPassRate}%
- Team avg readiness: ${data.teamSummary?.avgScore ?? "N/A"}/100

Write a 2-3 sentence executive summary of the organization's sales readiness health.`;
  }

  else {
    return res.status(400).json({ error: "Invalid scope" });
  }

  // ── Call OpenAI ──────────────────────────────────────────────────────────────
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       "gpt-4o-mini",
        max_tokens:  300,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt   },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("[ralli] OpenAI error:", response.status, errBody);
      return res.status(200).json({
        summary:         null,
        recommendations: recs,
        aiAvailable:     false,
        reason:          `OpenAI returned ${response.status}`,
      });
    }

    const json    = await response.json();
    const summary = json.choices?.[0]?.message?.content?.trim() ?? null;

    return res.status(200).json({
      summary,
      recommendations: recs,
      aiAvailable:     true,
    });
  } catch (err) {
    console.error("[ralli] ai-insights fetch error:", err);
    return res.status(200).json({
      summary:         null,
      recommendations: recs,
      aiAvailable:     false,
      reason:          err.message,
    });
  }
}
