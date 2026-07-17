/**
 * POST /api/contact
 *
 * Receives a marketing contact form submission and delivers it to the
 * ralli inbox via Resend. The API key never leaves the server.
 *
 * Body (JSON):
 *   type     string  — "demo" | "general" | "join"   (required)
 *   name     string                                   (required)
 *   email    string  — visitor's email                (required)
 *   company  string                                   (optional)
 *   role     string                                   (optional)
 *   message  string                                   (required)
 *
 * Returns:
 *   200  { success: true, emailId: string }
 *   400  { error: string }
 *   500  { error: string }
 *
 * Required environment variables (set in Vercel dashboard):
 *   RESEND_API_KEY   — Resend API key (required)
 *   RESEND_FROM      — Verified sender address, e.g. "ralli <contact@runralli.com>"
 *                      Defaults to "ralli <onboarding@resend.dev>" (Resend test sender;
 *                      works on free plan only when recipient == account owner email)
 *   CONTACT_TO       — Destination inbox. Defaults to "avanti@runralli.com"
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    type    = "general",
    name,
    email,
    company = "",
    role    = "",
    message,
  } = req.body ?? {};

  // ── Server-side validation ────────────────────────────────────────────────
  const errs = [];
  if (!name?.trim())                            errs.push("name is required");
  if (!email?.trim())                           errs.push("email is required");
  if (email && !/\S+@\S+\.\S+/.test(email))    errs.push("email is invalid");
  if (!message?.trim())                         errs.push("message is required");

  if (errs.length) {
    return res.status(400).json({ error: errs.join("; ") });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[contact] RESEND_API_KEY is not configured");
    return res.status(500).json({ error: "Email service not configured" });
  }

  const from    = process.env.RESEND_FROM ?? "ralli <onboarding@resend.dev>";
  const to      = process.env.CONTACT_TO  ?? "avanti@runralli.com";
  const subject = buildSubject(type, name);
  const html    = buildEmailHtml({ type, name, email, company, role, message });

  console.info("[contact] Sending submission", { type, name, email, company, role, to, from });

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], reply_to: [email], subject, html }),
    });

    const body = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("[contact] Resend rejected request", { status: r.status, body });
      return res.status(r.status).json({
        error: body?.message ?? `Resend error (HTTP ${r.status})`,
      });
    }

    console.info("[contact] Email accepted", { emailId: body.id, to });
    return res.status(200).json({ success: true, emailId: body.id ?? null });

  } catch (err) {
    console.error("[contact] Unexpected error", { message: err.message });
    return res.status(500).json({ error: err.message ?? "Unknown error" });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSubject(type, name) {
  const label = {
    demo:    "Demo Request",
    join:    "Job Application",
    general: "General Inquiry",
  }[type] ?? "New Inquiry";
  return `[ralli] ${label} from ${name}`;
}

function buildEmailHtml({ type, name, email, company, role, message }) {
  const typeLabel = {
    demo:    "Book a Demo",
    join:    "Joining the Team",
    general: "General Inquiry",
  }[type] ?? "New Inquiry";

  const submittedAt = new Date().toLocaleString("en-US", {
    timeZone:    "America/New_York",
    dateStyle:   "full",
    timeStyle:   "short",
  });

  const field = (label, value) => value?.trim()
    ? `<tr>
        <td style="padding:8px 0;font-size:12px;font-weight:700;color:#9CA3AF;width:120px;vertical-align:top;">${esc(label)}</td>
        <td style="padding:8px 0;font-size:14px;color:#111827;line-height:1.55;">${esc(value)}</td>
       </tr>`
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Contact Form Submission</title>
</head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;border:1px solid #E5E7EB;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#FDBF24;padding:24px 36px;">
              <div style="font-size:20px;font-weight:900;color:#0B1220;letter-spacing:-0.3px;">ralli</div>
              <div style="font-size:12px;font-weight:600;color:rgba(11,18,32,0.6);margin-top:3px;">New contact form submission</div>
            </td>
          </tr>

          <!-- Type badge -->
          <tr>
            <td style="padding:24px 36px 0;">
              <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#CC9800;background:#FFF3C7;border:1px solid rgba(253,191,36,0.4);border-radius:100px;padding:4px 12px;">
                ${esc(typeLabel)}
              </span>
            </td>
          </tr>

          <!-- Fields -->
          <tr>
            <td style="padding:20px 36px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                ${field("Name",    name)}
                ${field("Email",   email)}
                ${field("Company", company)}
                ${field("Role",    role)}
              </table>
            </td>
          </tr>

          <!-- Message -->
          <tr>
            <td style="padding:20px 36px;">
              <div style="font-size:12px;font-weight:700;color:#9CA3AF;margin-bottom:8px;">MESSAGE</div>
              <div style="font-size:14px;color:#111827;line-height:1.65;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px;">
                ${esc(message).replace(/\n/g, "<br />")}
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 36px;background:#F9FAFB;border-top:1px solid #E5E7EB;">
              <p style="margin:0;font-size:11px;color:#9CA3AF;">
                Submitted ${esc(submittedAt)} ET &middot; ralli.io
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
