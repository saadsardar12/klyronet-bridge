/**
 * Klyronet Baileys Bridge — v7 with native LID fix
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
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT        = process.env.PORT         || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL  || 'https://klyronet.com/api/wa/baileys-webhook.php';
const AUTH_TOKEN  = process.env.AUTH_TOKEN   || 'klyronet-secret-2024';
const SESS_DIR    = process.env.SESSIONS_DIR || './sessions';

if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR, { recursive: true });

const sessions = {};
const qrImages = {};
const logger   = pino({ level: 'silent' });

// ── LID → Phone number mapping store ─────────────────────
const lidToPhone = {}; // lid → real phone number

function resolvePhone(msg, jid) {
  // v7 native: remoteJidAlt has real @s.whatsapp.net when remoteJid is @lid
  if (msg.key.remoteJidAlt) {
    const phone = msg.key.remoteJidAlt.split('@')[0];
    if (phone && !phone.startsWith('500')) {
      // Cache LID → phone mapping
      lidToPhone[jid.split('@')[0]] = phone;
      return phone;
    }
  }

  // v7 native: senderPn field
  if (msg.key.senderPn) {
    const phone = msg.key.senderPn.replace(/[^0-9]/g, '');
    if (phone) {
      lidToPhone[jid.split('@')[0]] = phone;
      return phone;
    }
  }

  // Check cached mapping
  const lidKey = jid.split('@')[0];
  if (lidToPhone[lidKey]) return lidToPhone[lidKey];

  // Fallback: use raw JID number
  return lidKey.split(':')[0];
}

async function createSession(instanceId) {
  if (sessions[instanceId]?.status === 'connected') {
    return { success: true, status: 'already_connected' };
  }

  const sessPath = path.join(SESS_DIR, instanceId);
  if (!fs.existsSync(sessPath)) fs.mkdirSync(sessPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessPath);
  const { version }          = await fetchLatestBaileysVersion();

  console.log(`[${instanceId}] Using Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger,
    auth                : state,
    printQRInTerminal   : false,
    shouldIgnoreJid     : jid => isJidBroadcast(jid) || isJidNewsletter(jid),
    mobile              : false,
    browser             : ['Klyronet', 'Chrome', '120.0.0'],
    syncFullHistory     : true,
    markOnlineOnConnect : false,
    retryRequestDelayMs : 2000,
    maxMsgRetryCount    : 3,
    getMessage          : async () => ({ conversation: '' }),
  });

  sessions[instanceId] = { socket: sock, status: 'connecting', phone: null, qr: null };

  // ── CONNECTION ────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      sessions[instanceId].status = 'qr_ready';
      sessions[instanceId].qr     = qr;
      try {
        qrImages[instanceId] = await qrcode.toDataURL(qr, { errorCorrectionLevel:'M', width:256 });
      } catch(e) { qrImages[instanceId] = qr; }
      console.log(`[${instanceId}] QR ready`);
    }

    if (connection === 'open') {
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
      await notify(instanceId, 'connection_close', { phone: sessions[instanceId].phone, status:'disconnected', logout });
      if (!logout) {
        setTimeout(() => createSession(instanceId), 5000);
      } else {
        try { fs.rmSync(sessPath, { recursive: true, force: true }); } catch(e) {}
        delete sessions[instanceId];
        delete qrImages[instanceId];
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── LID MAPPING — track contacts for phone resolution ─
  sock.ev.on('contacts.update', (contacts) => {
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        const lid   = contact.lid.split('@')[0];
        const phone = contact.id.split('@')[0];
        if (!phone.startsWith('500')) {
          lidToPhone[lid] = phone;
          console.log(`[${instanceId}] LID mapped: ${lid} → ${phone}`);
        }
      }
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        const lid   = contact.lid.split('@')[0];
        const phone = contact.id.split('@')[0];
        if (!phone.startsWith('500')) {
          lidToPhone[lid] = phone;
        }
      }
    }
  });

  // ── HISTORY SYNC ──────────────────────────────────────
  sock.ev.on('messaging-history.set', async ({ messages: histMsgs }) => {
    console.log(`[${instanceId}] History: ${histMsgs.length} messages`);
    for (const msg of histMsgs.slice(0, 100)) { // limit to 100 history msgs
      if (!msg.message) continue;
      const jid = msg.key.remoteJid ?? '';
      if (isJidGroup(jid) || isJidBroadcast(jid)) continue;

      const phone     = resolvePhone(msg, jid);
      const body      = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
      if (!body) continue;

      const direction = msg.key.fromMe ? 'out' : 'in';
      await notify(instanceId, 'message_received', {
        from: phone, body, type: 'text',
        timestamp: msg.messageTimestamp,
        msgId: msg.key.id, direction, isHistory: true,
      });
    }
  });

  // ── INCOMING MESSAGES ──────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid ?? '';
      if (isJidGroup(jid) || isJidBroadcast(jid)) continue;

      // Resolve real phone number using v7 native fields
      const phone = resolvePhone(msg, jid);

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
        '[Message]';

      console.log(`[${instanceId}] MSG from ${phone} (JID: ${jid}, alt: ${msg.key.remoteJidAlt}, pn: ${msg.key.senderPn}): ${body.substring(0,50)}`);

      await notify(instanceId, 'message_received', {
        from: phone, body, type: contentType,
        timestamp: msg.messageTimestamp,
        msgId: msg.key.id,
      });
    }
  });

  return { success: true, status: 'connecting' };
}

async function notify(instanceId, event, data) {
  try {
    await axios.post(WEBHOOK_URL, { instance: instanceId, event, ...data }, {
      headers: { 'X-Auth-Token': AUTH_TOKEN },
      timeout: 10000,
    });
  } catch(e) {
    console.error(`[${instanceId}] Webhook failed:`, e.message);
  }
}

function auth(req, res, next) {
  const t = req.headers['x-auth-token'] ?? req.query.token;
  if (t !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/', (req, res) => res.json({
  service: 'Klyronet Baileys Bridge v7',
  status : 'running',
  sessions: Object.keys(sessions).length,
}));

app.post('/connect', auth, async (req, res) => {
  const { instance } = req.body;
  if (!instance) return res.status(400).json({ error: 'instance required' });
  res.json(await createSession(instance));
});

app.get('/qr/:instance', auth, async (req, res) => {
  const { instance } = req.params;
  if (!sessions[instance]) await createSession(instance);
  for (let i = 0; i < 30; i++) {
    if (qrImages[instance] || sessions[instance]?.status === 'connected') break;
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

app.get('/status/:instance', auth, (req, res) => {
  const s = sessions[req.params.instance];
  if (!s) return res.json({ status: 'not_found' });
  res.json({ status: s.status, phone: s.phone });
});

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
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await s.socket.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/disconnect/:instance', auth, async (req, res) => {
  const s = sessions[req.params.instance];
  if (s?.socket) { try { await s.socket.logout(); } catch(e) {} }
  delete sessions[req.params.instance];
  delete qrImages[req.params.instance];
  res.json({ success: true });
});

app.get('/instances', auth, (req, res) => {
  res.json({
    instances: Object.entries(sessions).map(([id, s]) => ({
      instance: id, status: s.status, phone: s.phone,
    }))
  });
});

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
  console.log(`Klyronet Baileys Bridge v7 on port ${PORT}`);
  await restore();
});
