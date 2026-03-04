/**
 * Ohio Rate Watch — Shared utilities
 * Used by server.js, lib/cron-handler.js, and scripts/daily-check.js
 */

// ---- Territory constants ----
export const TERRITORY_IDS = { columbia: 8, enbridge: 1, centerpoint: 11, duke: 10 };
export const TERRITORY_NAMES = {
  columbia: 'Columbia Gas of Ohio',
  enbridge: 'Enbridge Gas Ohio',
  centerpoint: 'CenterPoint Energy Ohio',
  duke: 'Duke Energy Ohio',
};

// ---- CORS / security headers ----
export function allHeaders(headers = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; img-src 'self' data: https:; font-src 'self' https://cdn.jsdelivr.net https://unpkg.com; connect-src 'self' https://api.resend.com https://nominatim.openstreetmap.org;",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    ...headers,
  };
}

// ---- Email via Resend ----
export async function sendEmail(to, subject, html) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Ohio Rate Watch <hello@ohioratewatch.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

// ---- IP-based rate limiting (in-memory) ----
const ipSignupLog = new Map();

export function isRateLimited(ip) {
  const now = Date.now();
  const window = 60 * 60 * 1000;
  const max = 5;
  const hits = (ipSignupLog.get(ip) || []).filter(t => now - t < window);
  if (hits.length >= max) return true;
  hits.push(now);
  ipSignupLog.set(ip, hits);
  return false;
}
