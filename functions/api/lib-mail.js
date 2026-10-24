/* ============================================================================
   lib-mail.js — transactional email for account verification and password reset.

   WHY THERE IS NO BUILT-IN SENDER
   -------------------------------
   Workers cannot send email on their own. There is no SMTP client, no local
   queue, and no "just send it" API on the platform. Delivering a password
   reset link therefore requires an HTTP email provider, which means an API key
   belongs in a Wrangler secret:

       npx wrangler pages secret put RESEND_API_KEY --project-name <name>

   WHAT HAPPENS IF THE KEY IS MISSING
   ---------------------------------
   Nothing is lost and nothing throws. The token is still generated, hashed and
   stored, and the API responds with the same success it would send with. The
   reset link is written to the Worker log instead of an inbox.

   That is deliberate. If the absence of an API key made /auth/forgot return an
   error, the endpoint would become an account-enumeration oracle: "no such
   account" versus "account found but mail is broken" would tell an attacker
   which addresses are registered. Failing identically and quietly is both
   safer and easier to test — the flow can be verified end to end with no
   third-party account at all, by reading the log.

   The console warning makes the misconfiguration loud for the developer without
   making it observable to an attacker.
   ========================================================================== */

'use strict';

/* Resend is used because it is the least painful of the options: a single
   bearer token, no SMTP credentials to rotate, and a free tier measured in
   thousands of messages per month. Every other provider would work here with a
   different fetch call and nothing else in this file would change. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'Mini Tank Legends <accounts@resend.dev>';

let warned = false;

/* sendResetEmail(env, to, link) -> Promise<boolean>
   Returns true when the message was handed to the provider, false when it was
   logged instead. Never throws: a mail failure must not turn a password reset
   into a 500 for the player. */
export async function sendResetEmail(env, to, link) {
  return deliver(env, to,
    'Reset your Mini Tank Legends password',
    [
      'Someone asked to reset the password on this account.',
      '',
      `Use this link to choose a new one. It works once and expires in 1 hour:`,
      '',
      link,
      '',
      'If this was not you, ignore this email. Nothing has changed and your',
      'current password still works.',
    ].join('\n'));
}

export async function sendVerifyEmail(env, to, link) {
  return deliver(env, to,
    'Confirm your Mini Tank Legends account',
    [
      'Welcome to Mini Tank Legends.',
      '',
      'Confirm this email address so you can recover your account if you forget',
      'your password. This link expires in 24 hours:',
      '',
      link,
      '',
      'If you did not create this account, you can ignore this email.',
    ].join('\n'));
}

async function deliver(env, to, subject, text) {
  const key = env.RESEND_API_KEY;

  if (!key) {
    /* Dev fallback. Logged, not emailed, and not reported to the caller. */
    if (!warned) {
      warned = true;
      console.warn(
        '[mail] RESEND_API_KEY is not set. Reset and verification emails are being ' +
        'LOGGED INSTEAD OF SENT. Set it with: npx wrangler pages secret put RESEND_API_KEY');
    }
    console.log(`[mail:log-only] to=${to} subject=${JSON.stringify(subject)}\n${text}\n`);
    return false;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || FROM_ADDRESS,
        to: [to],
        subject,
        text,
      }),
    });

    if (!res.ok) {
      /* The provider rejecting a message is an operational problem, not a
         client error. Log it and let the flow continue quietly — the token is
         already stored, so a retry or a support request can still rescue it. */
      const detail = await res.text().catch(() => '');
      console.error(`[mail] provider returned ${res.status}: ${detail.slice(0, 400)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[mail] send failed: ${String(err)}`);
    return false;
  }
}