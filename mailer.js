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

function normalizePhone(rawPhone) {
  const cleaned = String(rawPhone ?? '').replace(/[\s\-()]/g, '').trim();
  if (!cleaned) return null;

  const defaultCode = (process.env.DEFAULT_COUNTRY_CODE || '+91').trim();
  const digitsOnly = cleaned.replace(/^\+/, '');

  if (!/^\d{10,15}$/.test(digitsOnly)) return null;

  let e164 = cleaned;
  if (!e164.startsWith('+')) {
    if (digitsOnly.length === 10) {
      e164 = `${defaultCode}${digitsOnly}`;
    } else if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
      e164 = `${defaultCode}${digitsOnly.slice(1)}`;
    } else {
      e164 = `+${digitsOnly}`;
    }
  }

  // Last 10 digits for Indian gateways like Fast2SMS
  const local10 = digitsOnly.slice(-10);

  return { e164, local10 };
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

async function sendDonationSms({
  phone,
  username,
  donationId,
  amount,
  eventTag,
}) {
  const formatted = normalizePhone(phone);
  if (!formatted) {
    return { status: 'skipped', reason: 'missing_or_invalid_phone' };
  }

  const receiptNo = `DON-${String(donationId).padStart(5, '0')}`;
  const formattedAmount = `Rs.${Number(amount).toLocaleString('en-IN')}`;
  const message = `Thank you ${username}! Donation of ${formattedAmount} for ${eventTag} received. Receipt: ${receiptNo}. - Account Hub`;

  const provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();

  // Option A: Twilio REST API
  if (
    provider === 'twilio' &&
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM
  ) {
    const sid = process.env.TWILIO_ACCOUNT_SID.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN.trim();
    const authHeader = Buffer.from(`${sid}:${authToken}`).toString('base64');

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: formatted.e164,
        From: process.env.TWILIO_FROM.trim(),
        Body: (process.env.TWILIO_TRIAL_TEMPLATE || '').trim() || message,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Twilio error (${res.status}): ${errText}`);
    }

    return { status: 'sent', provider: 'twilio', to: formatted.e164 };
  }

  // Option B: Fast2SMS Quick SMS API (India)
  if (provider === 'fast2sms' && process.env.FAST2SMS_API_KEY) {
    const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        authorization: process.env.FAST2SMS_API_KEY.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        route: 'q',
        message,
        numbers: formatted.local10,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.return === false) {
      throw new Error(`Fast2SMS error (${res.status}): ${JSON.stringify(data)}`);
    }

    return { status: 'sent', provider: 'fast2sms', to: formatted.local10 };
  }

  // Fallback: Test Mode (prints SMS to server console)
  console.log(`[SMS TEST MODE] To: ${formatted.e164} | Body: ${message}`);
  return { status: 'sent', provider: 'test', to: formatted.e164, testMode: true };
}

async function sendDonationAcknowledgement({
  to,
  phone,
  username,
  donationId,
  amount,
  eventTag,
  note,
  date,
}) {
  const formattedAmount = '₹' + Number(amount).toLocaleString('en-IN');
  const receiptNo = `DON-${String(donationId).padStart(5, '0')}`;
  const formattedDate = new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  const result = {
    email: { status: 'skipped', previewUrl: null },
    sms: { status: 'skipped', to: null, testMode: false },
  };

  // 1. Send Email Acknowledgement
  if (to) {
    try {
      const transporter = await getTransporter();
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

      result.email = { status: 'sent', previewUrl };
    } catch (mailErr) {
      console.error('Failed to send acknowledgement email:', mailErr.message);
      result.email = { status: 'failed', previewUrl: null };
    }
  }

  // 2. Send Automated SMS Acknowledgement
  if (phone) {
    try {
      const smsRes = await sendDonationSms({
        phone,
        username,
        donationId,
        amount,
        eventTag,
      });
      result.sms = smsRes;
    } catch (smsErr) {
      console.error('Failed to send acknowledgement SMS:', smsErr.message);
      result.sms = { status: 'failed', to: null };
    }
  }

  return result;
}

module.exports = { sendDonationAcknowledgement, sendDonationSms };