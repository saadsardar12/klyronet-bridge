/**
 * Klyronet Baileys Bridge
 * Uses JID (not LID) for WhatsApp connections
 * Deploy on Railway.app
 */

const express = require('express');
const axios   = require('axios');
const qrcode  = require('qrcode');
const fs      = require('fs');
const path    = require('path');
const pino    = require('pino');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  getContentType,
  proto,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://klyronet.com/api/wa/baileys-webhook.php';
const AUTH_TOKEN  = process.env.AUTH_TOKEN  || 'klyronet-secret-2024';
const SESS_DIR    = process.env.SESSIONS_DIR|| './sessions';

if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR, { recursive: true });

const sessions = {}; // instanceId → { socket, status, phone, qr }
const qrImages = {}; // instanceId → base64 QR
const logger   = pino({ level: 'silent' });

// ── CREATE SESSION ────────────────────────────────────────
async function createSession(instanceId) {
  if (sessions[instanceId]?.status === 'connected') {
    return { success: true, status: 'already_connected' };
  }

  const sessPath = path.join(SESS_DIR, instanceId);
  if (!fs.existsSync(sessPath)) fs.mkdirSync(sessPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessPath);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth                : state,
    printQRInTerminal   : false,
    // ── JID fix — use regular JID not LID ──────────────
    shouldIgnoreJid     : jid =>
      isJidBroadcast(jid) || isJidNewsletter(jid),
    // Force standard JID mode
    mobile              : false,
    browser             : ['Klyronet', 'Chrome', '120.0.0'],
    syncFullHistory     : false,
    markOnlineOnConnect : false,
    retryRequestDelayMs : 2000,
    maxMsgRetryCount    : 3,
  });

  sessions[instanceId] = {
    socket : sock,
    status : 'connecting',
    phone  : null,
    qr     : null,
  };

  // ── CONNECTION EVENTS ─────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

    if (qr) {
      sessions[instanceId].status = 'qr_ready';
      sessions[instanceId].qr     = qr;
      try { qrImages[instanceId] = await qrcode.toDataURL(qr); } catch(e) {}
      console.log(`[${instanceId}] QR ready`);
    }

    if (connection === 'open') {
      // Get JID (not LID) — use jidNormalizedUser for clean JID
      const rawJid = sock.user?.id ?? '';
      const phone  = jidNormalizedUser(rawJid)?.split('@')[0]
                  ?? rawJid.split(':')[0]
                  ?? rawJid.split('@')[0];

      sessions[instanceId].status = 'connected';
      sessions[instanceId].phone  = phone;
      sessions[instanceId].qr     = null;
      qrImages[instanceId]        = null;
      console.log(`[${instanceId}] Connected as ${phone}`);

      await notify(instanceId, 'connection_open', { phone, status: 'connected' });
    }

    if (connection === 'close') {
      const code   = lastDisconnect?.error?.output?.statusCode;
      const logout = code === DisconnectReason.loggedOut;
      console.log(`[${instanceId}] Closed. Code: ${code}. Logout: ${logout}`);

      sessions[instanceId].status = 'disconnected';
      await notify(instanceId, 'connection_close', {
        phone : sessions[instanceId].phone,
        status: 'disconnected',
        logout,
      });

      if (!logout) {
        // Auto reconnect after 5s
        setTimeout(() => createSession(instanceId), 5000);
      } else {
        // Clean up session files on logout
        try { fs.rmSync(sessPath, { recursive: true, force: true }); } catch(e) {}
        delete sessions[instanceId];
        delete qrImages[instanceId];
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── INCOMING MESSAGES ──────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid ?? '';

      // Skip groups and broadcasts — only 1-to-1 JIDs
      if (isJidGroup(jid))     continue;
      if (isJidBroadcast(jid)) continue;

      // Get clean phone from JID
      const phone = jidNormalizedUser(jid)?.split('@')[0] ?? jid.split('@')[0];

      // Get message content
      const contentType = getContentType(msg.message) ?? 'text';
      const body =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.imageMessage?.caption ??
        msg.message?.videoMessage?.caption ??
        (contentType === 'audioMessage'    ? '[Voice Message]' : null) ??
        (contentType === 'imageMessage'    ? '[Image]'         : null) ??
        (contentType === 'videoMessage'    ? '[Video]'         : null) ??
        (contentType === 'documentMessage' ? '[Document]'      : null) ??
        (contentType === 'stickerMessage'  ? '[Sticker]'       : null) ??
        '[Message]';

      console.log(`[${instanceId}] MSG from ${phone}: ${body.substring(0,60)}`);

      await notify(instanceId, 'message_received', {
        from     : phone,
        body,
        type     : contentType,
        timestamp: msg.messageTimestamp,
        msgId    : msg.key.id,
      });
    }
  });

  return { success: true, status: 'connecting' };
}

// ── NOTIFY PHP ────────────────────────────────────────────
async function notify(instanceId, event, data) {
  try {
    await axios.post(WEBHOOK_URL, {
      instance: instanceId,
      event,
      ...data,
    }, {
      headers : { 'X-Auth-Token': AUTH_TOKEN },
      timeout : 10000,
    });
  } catch(e) {
    console.error(`[${instanceId}] Webhook failed:`, e.message);
  }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function auth(req, res, next) {
  const t = req.headers['x-auth-token'] ?? req.query.token;
  if (t !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── ROUTES ────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  service : 'Klyronet Baileys Bridge',
  status  : 'running',
  sessions: Object.keys(sessions).length,
}));

// Start instance
app.post('/connect', auth, async (req, res) => {
  const { instance } = req.body;
  if (!instance) return res.status(400).json({ error: 'instance required' });
  const r = await createSession(instance);
  res.json(r);
});

// Get QR
app.get('/qr/:instance', auth, async (req, res) => {
  const { instance } = req.params;

  if (!sessions[instance]) await createSession(instance);

  // Wait up to 15s for QR
  for (let i = 0; i < 30; i++) {
    if (qrImages[instance]) break;
    if (sessions[instance]?.status === 'connected') break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (sessions[instance]?.status === 'connected') {
    return res.json({ status: 'connected', phone: sessions[instance].phone });
  }
  if (qrImages[instance]) {
    return res.json({ status: 'qr_ready', qr: qrImages[instance] });
  }
  res.json({ status: 'connecting' });
});

// Status
app.get('/status/:instance', auth, (req, res) => {
  const s = sessions[req.params.instance];
  if (!s) return res.json({ status: 'not_found' });
  res.json({ status: s.status, phone: s.phone });
});

// Send message
app.post('/send', auth, async (req, res) => {
  const { instance, to, message } = req.body;
  if (!instance || !to || !message) {
    return res.status(400).json({ error: 'instance, to, message required' });
  }
  const s = sessions[instance];
  if (!s || s.status !== 'connected') {
    return res.status(400).json({ error: 'Not connected' });
  }
  try {
    // Use proper JID format
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await s.socket.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Disconnect
app.post('/disconnect/:instance', auth, async (req, res) => {
  const s = sessions[req.params.instance];
  if (s?.socket) { try { await s.socket.logout(); } catch(e) {} }
  delete sessions[req.params.instance];
  delete qrImages[req.params.instance];
  res.json({ success: true });
});

// List instances
app.get('/instances', auth, (req, res) => {
  res.json({
    instances: Object.entries(sessions).map(([id, s]) => ({
      instance: id, status: s.status, phone: s.phone,
    }))
  });
});

// ── RESTORE SESSIONS ON STARTUP ───────────────────────────
async function restore() {
  if (!fs.existsSync(SESS_DIR)) return;
  for (const dir of fs.readdirSync(SESS_DIR)) {
    const full = path.join(SESS_DIR, dir);
    if (fs.statSync(full).isDirectory()) {
      console.log('Restoring:', dir);
      await createSession(dir);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

app.listen(PORT, async () => {
  console.log(`Klyronet Baileys Bridge on port ${PORT}`);
  await restore();
});
