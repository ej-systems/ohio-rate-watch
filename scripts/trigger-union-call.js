#!/usr/bin/env node
/**
 * Union Hall Job Listing Caller
 *
 * Triggers a Twilio outbound call to the union hall job hotline.
 * The call connects, presses 7, records the job listing, and
 * Twilio transcribes + emails the result to Jim.
 *
 * Usage:
 *   node scripts/trigger-union-call.js
 *
 * Env vars (in .env):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM        — your Twilio number (+18145244535)
 *   UNION_HALL_NUMBER  — the number to call (+12164473464)
 */

import 'dotenv/config';
import https from 'https';
import { URLSearchParams } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const FROM          = process.env.TWILIO_FROM || '+18145244535';
const TO            = process.env.UNION_HALL_NUMBER || '+12164473464';
const TWIML_URL     = 'https://ohioratewatch.com/api/union-twiml';

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error('ERROR: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required in .env');
  process.exit(1);
}

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

async function makeCall() {
  log(`Calling ${TO} from ${FROM}...`);

  const body = new URLSearchParams({
    To:   TO,
    From: FROM,
    Url:  TWIML_URL,
  });

  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body.toString()),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const json = JSON.parse(data);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`Call initiated! SID: ${json.sid}, Status: ${json.status}`);
          resolve(json);
        } else {
          reject(new Error(`Twilio error ${res.statusCode}: ${json.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body.toString());
    req.end();
  });
}

makeCall()
  .then(() => log('Done. Transcription will be emailed when ready.'))
  .catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
