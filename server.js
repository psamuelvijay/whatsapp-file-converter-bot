// server.js
require('dotenv').config({ path: './creds.env' });

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const app = express();

// ------------- CONFIG -------------
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. whatsapp:+1415...
let PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null; // optional; if not set we try ngrok
const PORT = process.env.PORT || 8085;

if (!accountSid || !authToken || !TWILIO_WHATSAPP_FROM) {
  console.error('ERROR: Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_WHATSAPP_NUMBER in creds.env');
  process.exit(1);
}

const client = twilio(accountSid, authToken);

// limits & paths
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

const PUBLIC_FILES_DIR = path.join(__dirname, 'public', 'files');
fs.mkdirSync(PUBLIC_FILES_DIR, { recursive: true });
app.use('/files', express.static(PUBLIC_FILES_DIR));

// parse form posts from Twilio
app.use(bodyParser.urlencoded({ extended: false }));

const sessions = new Map();
const SUPPORTED_FORMATS = ['pdf', 'png', 'jpg', 'word', 'csv', 'txt']; // canonical formats

// ------------- UTILITIES -------------
function log(...args) { console.log(new Date().toISOString(), ...args); }
function warn(...args) { console.warn(new Date().toISOString(), ...args); }
function errlog(...args) { console.error(new Date().toISOString(), ...args); }

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function sanitizeFilename(filename = '') {
  return filename.replace(/[^a-zA-Z0-9_\.\-]/g, '_').slice(0, 200);
}

/** Detect file type using magic bytes + simple heuristics */
function detectFileType(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 4 && buf.slice(0, 4).equals(Buffer.from([0x25,0x50,0x44,0x46]))) return 'pdf'; // %PDF
    if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return 'png'; // PNG
    if (buf.length >= 3 && buf.slice(0, 3).equals(Buffer.from([0xFF,0xD8,0xFF]))) return 'jpg'; // JPEG
    if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1]))) return 'word'; // old doc
    if (buf.length >= 4 && buf.slice(0, 4).equals(Buffer.from([0x50,0x4B,0x03,0x04]))) {
      // likely DOCX (zip container) — treat as word
      return 'word';
    }

    // text / csv heuristic on first 4KB
    const textSample = buf.slice(0, Math.min(buf.length, 4096)).toString('utf8');
    let printable = 0;
    for (let i = 0; i < textSample.length; i++) {
      const code = textSample.charCodeAt(i);
      if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) printable++;
    }
    const ratio = printable / Math.max(1, textSample.length);
    if (ratio > 0.9) {
      if (textSample.includes(',')) return 'csv';
      return 'txt';
    }

    return 'unknown';
  } catch (e) {
    errlog('detectFileType error:', e);
    return 'unknown';
  }
}

/** Try to download Twilio media (with small retry). Provides helpful 401 message */
async function downloadMedia(url) {
  const retries = 2;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const tempPath = path.join(__dirname, `temp_${Date.now()}_${Math.floor(Math.random()*1000)}`);
      const writer = fs.createWriteStream(tempPath);

      log(`Downloading Twilio media (attempt ${attempt+1}) from:`, url);
      const resp = await axios.get(url, {
        responseType: 'stream',
        auth: { username: accountSid, password: authToken },
        timeout: 60_000,
        maxRedirects: 5
      });

      resp.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const stats = fs.statSync(tempPath);
      if (stats.size > MAX_FILE_SIZE_BYTES) {
        fs.unlinkSync(tempPath);
        throw new Error(`File too large (> ${MAX_FILE_SIZE_BYTES} bytes).`);
      }
      log('Downloaded media to', tempPath, 'sizeBytes=', stats.size);
      return tempPath;
    } catch (e) {
      lastErr = e;
      // helpful diagnostic for auth problems
      if (e.response && e.response.status === 401) {
        errlog('Twilio media download returned 401 Unauthorized. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in creds.env — they seem incorrect.');
        throw new Error('Unauthorized fetching Twilio media (401). Check Twilio credentials.');
      }
      warn(`Download attempt ${attempt+1} failed:`, e.message || e);
      // small backoff
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Failed to download media');
}

/** Convert file placeholder — replace with real conversions when ready.
 *  For safety we copy into PUBLIC_FILES_DIR and return that path.
 */
async function convertFileLogic(inputFilePath, toFormat) {
  // sanitize and create converted filename
  const outName = `converted_${Date.now()}.${toFormat}`;
  const outPath = path.join(PUBLIC_FILES_DIR, sanitizeFilename(outName));

  // For now a safe copy. Replace later with real conversion logic.
  fs.copyFileSync(inputFilePath, outPath);
  log('Conversion placeholder: copied to', outPath);
  return outPath;
}

/** Send Twilio message containing mediaUrl. Retries a few times and returns true/false */
async function sendFileMessageWithRetries(to, publicUrl) {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      log(`Sending media to ${to} via Twilio (attempt ${i+1}): ${publicUrl}`);
      const msg = await client.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to,
        mediaUrl: [publicUrl],
        body: 'Here is your converted file!'
      });
      log('Twilio send success sid=', msg.sid);
      return { ok: true, sid: msg.sid };
    } catch (e) {
      warn(`Twilio send attempt ${i+1} failed:`, e && e.message ? e.message : e);
      // if Twilio reports that the URL is not fetchable, e.g., 400/403/404 in nested info,
      // we'll log the full error so you can inspect.
      if (i === attempts - 1) {
        errlog('Twilio final send error:', e);
        return { ok: false, error: e };
      }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return { ok: false, error: new Error('Unknown send failure') };
}

/** Build menu string */
function buildOptionsMenu(excludeFormat) {
  return SUPPORTED_FORMATS
    .filter(f => f !== excludeFormat)
    .map((f, i) => `${i + 1}) ${f}`)
    .join('\n');
}

/** Try to read ngrok API to discover public URL (optional) */
async function tryGetNgrokUrl() {
  try {
    const localApi = 'http://127.0.0.1:4040/api/tunnels';
    const r = await axios.get(localApi, { timeout: 2000 });
    if (r.data && Array.isArray(r.data.tunnels) && r.data.tunnels.length) {
      // pick first https tunnel
      const httpsTunnel = r.data.tunnels.find(t => t.public_url && t.public_url.startsWith('https://'));
      if (httpsTunnel) {
        log('Detected ngrok public URL from local API:', httpsTunnel.public_url);
        return httpsTunnel.public_url.replace(/\/$/, '');
      }
    }
  } catch (e) {
    // no ngrok or blocked — that's fine, we'll fallback later
  }
  return null;
}

// ------------- ROUTES -------------
app.post('/whatsapp_webhook', async (req, res) => {
  const from = req.body.From || '';
  const incomingText = (req.body.Body || '').trim().toLowerCase();
  const mediaUrl = req.body.MediaUrl0;
  const mediaContentType = req.body.MediaContentType0 || '';
  const mediaFilename = req.body.MediaFilename0 || '';

  // session bookkeeping
  let session = sessions.get(from) || { stage: 'waiting_file', lastActive: Date.now() };
  session.lastActive = Date.now();
  sessions.set(from, session);

  try {
    // ---------- STEP 1: waiting for file ----------
    if (session.stage === 'waiting_file') {
      if (!mediaUrl) {
        return res.type('text/xml').send(`<Response><Message>${escapeXml('Please send the file you want to convert.')}</Message></Response>`);
      }

      // Download file (with robust errors)
      let tempFile;
      try {
        tempFile = await downloadMedia(mediaUrl);
      } catch (err) {
        errlog('Failed to download media:', err.message || err);
        // quick helpful reply
        return res.type('text/xml').send(`<Response><Message>${escapeXml('Could not download your file. Check bot logs or Twilio credentials; please try again.')}</Message></Response>`);
      }

      // Detect type
      let detected = detectFileType(tempFile);
      // fallback to Twilio provided content-type or filename extension
      if ((!detected || detected === 'unknown') && mediaContentType) {
        const ct = mediaContentType.toLowerCase();
        if (ct.includes('png')) detected = 'png';
        else if (ct.includes('jpeg') || ct.includes('jpg')) detected = 'jpg';
        else if (ct.includes('pdf')) detected = 'pdf';
        else if (ct.includes('csv')) detected = 'csv';
        else if (ct.includes('text')) detected = 'txt';
      }
      if ((!detected || detected === 'unknown') && mediaFilename) {
        const ext = path.extname(mediaFilename).slice(1).toLowerCase();
        const map = { jpeg: 'jpg', doc: 'word', docx: 'word' };
        detected = map[ext] || ext || detected;
      }
      if (detected === 'jpeg') detected = 'jpg';

      if (!detected || !SUPPORTED_FORMATS.includes(detected)) {
        // unsupported — cleanup and inform user
        fs.existsSync(tempFile) && fs.unlinkSync(tempFile);
        return res.type('text/xml').send(`<Response><Message>${escapeXml('Unsupported file type. Send PDF, PNG, JPG, Word (doc/docx), CSV, or TXT.')}</Message></Response>`);
      }

      // save session
      session.uploadedFile = tempFile;
      session.detectedFormat = detected;
      session.optionsList = SUPPORTED_FORMATS.filter(f => f !== detected);
      session.stage = 'awaiting_format_choice';
      sessions.set(from, session);

      const reply = `You have uploaded a ${detected} file.\nWhich format would you like to convert it to?\n${buildOptionsMenu(detected)}`;
      return res.type('text/xml').send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
    }

    // ---------- STEP 2: awaiting format choice ----------
    if (session.stage === 'awaiting_format_choice') {
      if (!session.optionsList || !session.uploadedFile) {
        sessions.delete(from);
        return res.type('text/xml').send(`<Response><Message>${escapeXml('Session expired. Please send your file again.')}</Message></Response>`);
      }

      let chosen = incomingText;
      // if numeric selection
      if (/^\d+$/.test(chosen)) {
        const idx = parseInt(chosen, 10) - 1;
        if (idx >= 0 && idx < session.optionsList.length) chosen = session.optionsList[idx];
      }

      if (!session.optionsList.includes(chosen)) {
        return res.type('text/xml').send(`<Response><Message>${escapeXml('Invalid choice. Reply with option number or format name.')}</Message></Response>`);
      }

      // Respond quickly to Twilio webhook (ack)
      res.type('text/xml').send(`<Response><Message>${escapeXml('Converting your file, please wait...')}</Message></Response>`);

      // Do conversion + send file asynchronously
      (async () => {
        const uploadedFilePath = session.uploadedFile;
        try {
          // convert
          const convertedPath = await convertFileLogic(uploadedFilePath, chosen);

          // figure out public base URL (PUBLIC_BASE_URL env, else try ngrok, else fallback to host)
          let baseUrl = PUBLIC_BASE_URL;
          if (!baseUrl) {
            const ngrokUrl = await tryGetNgrokUrl();
            if (ngrokUrl) baseUrl = ngrokUrl;
            else {
              // fallback to the host from incoming request is not accessible by Twilio if it's localhost,
              // but we logged this earlier — still allow it so user sees a helpful message if it fails.
              baseUrl = `${req.protocol}://${req.get('host')}`;
            }
          }
          baseUrl = baseUrl.replace(/\/$/, ''); // strip trailing slash
          const publicUrl = `${baseUrl}/files/${encodeURIComponent(path.basename(convertedPath))}`;

          log('Public URL for Twilio:', publicUrl);

          // Now send via Twilio with retries
          const result = await sendFileMessageWithRetries(from, publicUrl);
          if (!result.ok) {
            // sending failed — tell user (text-only fallback)
            await client.messages.create({
              from: TWILIO_WHATSAPP_FROM,
              to: from,
              body: 'Failed to deliver converted file. Please try again later or check bot logs.'
            });
          } else {
            // success — no immediate delete of convertedPath. cleanup job will remove it later.
            log('Delivered converted file to user:', from, 'file:', convertedPath);
          }
        } catch (e) {
          errlog('Async convert/send error:', e);
          try {
            await client.messages.create({
              from: TWILIO_WHATSAPP_FROM,
              to: from,
              body: 'An error occurred while converting your file. Please try again.'
            });
          } catch (notifyErr) {
            errlog('Failed to send error notice to user:', notifyErr);
          }
        } finally {
          // delete uploaded temp file immediately (converted copy remains for Twilio)
          try { if (uploadedFilePath && fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath); } catch {}
          sessions.delete(from);
        }
      })();

      return; // response already sent
    }

    // default fallback
    sessions.delete(from);
    return res.type('text/xml').send(`<Response><Message>${escapeXml('Something went wrong. Please send your file again.')}</Message></Response>`);
  } catch (err) {
    errlog('Webhook error:', err);
    // attempt cleanup
    try { if (session.uploadedFile && fs.existsSync(session.uploadedFile)) fs.unlinkSync(session.uploadedFile); } catch {}
    sessions.delete(from);
    return res.status(500).send('Internal Server Error');
  }
});

// ------------- BACKGROUND CLEANUP -------------
// delete converted_ and temp_ files older than CLEANUP_MAX_AGE_MS
setInterval(() => {
  const now = Date.now();

  // cleanup public converted files
  fs.readdir(PUBLIC_FILES_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const fp = path.join(PUBLIC_FILES_DIR, file);
      fs.stat(fp, (err, s) => {
        if (err) return;
        if (now - s.mtimeMs > CLEANUP_MAX_AGE_MS && file.startsWith('converted_')) {
          log('Removing old converted file:', fp);
          fs.unlink(fp, () => {});
        }
      });
    });
  });

  // cleanup temp_ files in project root
  fs.readdir(__dirname, (err, files) => {
    if (err) return;
    files.forEach(file => {
      if (!file.startsWith('temp_')) return;
      const fp = path.join(__dirname, file);
      fs.stat(fp, (err, s) => {
        if (err) return;
        if (now - s.mtimeMs > CLEANUP_MAX_AGE_MS) {
          log('Removing old temp file:', fp);
          fs.unlink(fp, () => {});
        }
      });
    });
  });
}, 60 * 60 * 1000); // hourly

// cleanup expired sessions (uploads older than SESSION_TIMEOUT_MS)
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions.entries()) {
    if (s.lastActive && now - s.lastActive > SESSION_TIMEOUT_MS) {
      if (s.uploadedFile && fs.existsSync(s.uploadedFile)) {
        try { fs.unlinkSync(s.uploadedFile); } catch (e) {}
      }
      sessions.delete(k);
      log('Cleared expired session for', k);
    }
  }
}, 60 * 1000);

// health
app.get('/', (req, res) => res.send('Smart Converter WhatsApp bot running!'));

// start
app.listen(PORT, () => {
  log(`Listening on port ${PORT}`);
  if (PUBLIC_BASE_URL) log('Using PUBLIC_BASE_URL from creds.env:', PUBLIC_BASE_URL);
  else log('PUBLIC_BASE_URL not set — will attempt to auto-detect ngrok or use request host.');
});
