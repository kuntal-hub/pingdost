import type { EmailContent } from './provider';

export type OtpPurpose = 'verify_email' | 'password_reset' | 'primary_replace';

const COPY: Record<OtpPurpose, { subject: string; lead: string; ignore?: string }> = {
  primary_replace: {
    subject: 'Your PingDost code to move to a new phone',
    lead: 'Use this code to make a new phone your PingDost phone. Your current phone will be signed out:',
    ignore: "If you didn't ask for this, someone may know your password: change it now.",
  },
  verify_email: {
    subject: 'Your PingDost verification code',
    lead: 'Use this code to verify your email address for PingDost:',
  },
  password_reset: {
    subject: 'Your PingDost password reset code',
    lead: 'Use this code to reset your PingDost password:',
  },
};

/** The OTP email. The code is the only variable part, so nothing user-supplied is rendered. */
export function otpEmail(purpose: OtpPurpose, code: string, ttlSeconds: number): EmailContent {
  const { subject, lead, ignore: warning } = COPY[purpose];
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const ignore = warning ?? "If you didn't ask for this, you can ignore this email.";
  const text = [
    lead,
    '',
    `    ${code}`,
    '',
    `It expires in ${minutes} minutes and works once. Never share it with anyone.`,
    ignore,
  ].join('\n');
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>${lead}</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,monospace">${code}</p>
<p>It expires in ${minutes} minutes and works once. Never share it with anyone.</p>
<p style="color:#666">${ignore}</p>
</body></html>`;
  return { subject, text, html };
}
