// Transactional email via Resend. RESEND_API_KEY is a Netlify env var.
const { Resend } = require('resend');

function getClient() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
  return new Resend(process.env.RESEND_API_KEY);
}

async function sendEmail({ to, subject, text }) {
  const from = process.env.MAIL_FROM || 'GoaTrip <onboarding@resend.dev>';
  const client = getClient();
  await client.emails.send({ from, to, subject, text });
}

module.exports = { sendEmail };
