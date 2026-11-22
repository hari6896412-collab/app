const nodemailer = require('nodemailer');

let cachedTransporter = null;
let isTestMode = false;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    const port = Number(process.env.SMTP_PORT) || 587;
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    isTestMode = false;
    return cachedTransporter;
  }

  const testAccount = await nodemailer.createTestAccount();
  cachedTransporter = nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
  isTestMode = true;
  return cachedTransporter;
}

async function sendDonationAcknowledgement({
  to,
  username,
  donationId,
  amount,
  eventTag,
  note,
  date,
}) {
  const transporter = await getTransporter();
  const formattedAmount = '₹' + Number(amount).toLocaleString('en-IN');
  const receiptNo = `DON-${String(donationId).padStart(5, '0')}`;
  const formattedDate = new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  const subject = `Donation Acknowledgement Letter (${receiptNo})`;

  const text = [
    `Dear ${username},`,
    '',
    'Thank you for your generous contribution! This letter formally acknowledges receipt of your donation.',
    '',
    `Receipt Number : ${receiptNo}`,
    `Date           : ${formattedDate}`,
    `Donor Name     : ${username}`,
    `Amount         : ${formattedAmount}`,
    `Event / Cause  : ${eventTag}`,
    note ? `Note           : ${note}` : null,
    '',
    'Note: This contribution was recorded in test mode (no real money was charged).',
    '',
    'With gratitude,',
    'Account Hub Team',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e1e2e; border: 2px solid #1e1e2e; border-radius: 12px; padding: 24px; background: #fffdf8;">
      <h2 style="margin-top: 0; color: #1e1e2e;">Donation Acknowledgement Letter</h2>
      <p>Dear <strong>${escapeHtml(username)}</strong>,</p>
      <p>Thank you for your generous contribution! This letter formally acknowledges receipt of your donation.</p>

      <table style="width: 100%; border-collapse: collapse; margin: 18px 0; background: #ffffff; border: 1px solid #cbd5e1;">
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">Receipt Number</td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(receiptNo)}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">Date</td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(formattedDate)}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">Donor</td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(username)}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">Amount</td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #15803d; font-weight: bold;">${escapeHtml(formattedAmount)}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">Event / Cause</td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(eventTag)}</td>
        </tr>
        ${
          note
            ? `<tr>
                 <td style="padding: 10px; font-weight: bold;">Note</td>
                 <td style="padding: 10px;">${escapeHtml(note)}</td>
               </tr>`
            : ''
        }
      </table>

      <p style="font-size: 12px; color: #64748b;">
        <em>Note: This contribution was recorded in test mode (no real money was charged).</em>
      </p>
      <p style="margin-bottom: 0;">With gratitude,<br /><strong>Account Hub Team</strong></p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '"Account Hub" <no-reply@accounthub.local>',
    to,
    subject,
    text,
    html,
  });

  const previewUrl = isTestMode ? nodemailer.getTestMessageUrl(info) : null;
  if (previewUrl) {
    console.log(`Test acknowledgement email preview: ${previewUrl}`);
  }

  return { sent: true, previewUrl };
}

module.exports = { sendDonationAcknowledgement };