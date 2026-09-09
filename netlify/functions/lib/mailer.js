// Transactional email via Resend. RESEND_API_KEY is a Netlify env var.
const { Resend } = require('resend');

function getClient() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
  return new Resend(process.env.RESEND_API_KEY);
}

async function sendEmail({ to, subject, text, attachments }) {
  const from = process.env.MAIL_FROM || 'GoaTrip <onboarding@resend.dev>';
  const client = getClient();
  const payload = { from, to, subject, text };
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  // IMPORTANT: the Resend SDK does NOT throw on API-level failures (bad
  // API key, unverified sender domain, recipient rejected, etc.) — it
  // resolves normally with { data, error }. Without checking `error`
  // here explicitly, a rejected send looks identical to a successful
  // one to every caller of sendEmail(), which is what was making admin
  // request emails silently vanish while the app reported success.
  const { data, error } = await client.emails.send(payload);
  if (error) {
    const detail = error.message || JSON.stringify(error);
    throw new Error(`Resend rejected the email: ${detail}`);
  }
  return data;
}

module.exports = { sendEmail };
