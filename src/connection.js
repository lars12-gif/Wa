import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const log = pino({ level: config.logLevel || 'silent' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const PAIRING_WINDOW_MS = 180_000;
const PAIRING_RETRY_MS = 4_000;
const STARTUP_SETTLE_MS = 2_000;

let activeSocket = null;
let bootGeneration = 0;
let reconnectTimer = null;
let pairingSession = null;

function cleanPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function statusCodeOf(error) {
  return error?.output?.statusCode ?? error?.statusCode ?? null;
}

function isRegistered(state) {
  return Boolean(state?.creds?.registered);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(onReady, delay = PAIRING_RETRY_MS) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startSocket(onReady);
  }, delay);
}

async function removeAuthDirectory() {
  try {
    await fs.rm(config.authDir, { recursive: true, force: true });
    await fs.mkdir(config.authDir, { recursive: true });
  } catch (error) {
    log.error({ error }, 'auth cleanup failed');
  }
}

function stopPairingTimer() {
  if (pairingSession?.timer) clearTimeout(pairingSession.timer);
  pairingSession = null;
}

async function expirePairingSession(sock, state, generation) {
  if (!pairingSession || pairingSession.generation !== generation) return;
  if (isRegistered(state)) {
    stopPairingTimer();
    return;
  }

  pairingSession.expired = true;
  console.log('\n🌋 Volcano\n⏱️ انتهت مهلة الربط (3 دقائق).\n🔐 تم إغلاق جلسة الربط.\n');

  try {
    // logout is intentionally used only for an unregistered pairing session.
    await sock.logout();
  } catch {
    try { sock.ws?.close(); } catch {}
  }

  stopPairingTimer();
  clearReconnectTimer();
  await removeAuthDirectory();
}

async function requestPairingCodeSafely(sock, state, generation) {
  if (!pairingSession || pairingSession.generation !== generation) return;
  if (pairingSession.requested || pairingSession.expired || isRegistered(state)) return;

  pairingSession.requested = true;

  try {
    // Official Baileys guidance uses the QR/connecting event as the trigger.
    // We additionally wait for the transport to settle before sending the IQ.
    await sleep(STARTUP_SETTLE_MS);

    if (pairingSession.expired || isRegistered(state)) return;

    const phone = cleanPhone(config.phone);
    if (!phone) throw new Error('PHONE_NUMBER is missing or invalid');
    if (phone.length < 8) throw new Error('PHONE_NUMBER must contain country code and digits only');

    const code = await sock.requestPairingCode(phone);

    if (!pairingSession || pairingSession.generation !== generation || pairingSession.expired) return;

    pairingSession.code = code;
    pairingSession.issuedAt = Date.now();

    console.log('\n┌──────────────────────────────────────┐');
    console.log('│        🌋 VOLCANO — ربط الجهاز       │');
    console.log('├──────────────────────────────────────┤');
    console.log(`│  رمز الربط: ${code}                  │`);
    console.log('│  الصلاحية: 3 دقائق                   │');
    console.log('│  WhatsApp → الأجهزة المرتبطة         │');
    console.log('│  → ربط جهاز → الربط برقم الهاتف      │');
    console.log('└──────────────────────────────────────┘\n');
  } catch (error) {
    pairingSession.requested = false;
    const code = statusCodeOf(error);

    // 428 means the socket closed before the pairing IQ could be sent.
    // Do not crash the process and do not erase the session yet; reconnect
    // inside the same 3-minute pairing window and request a fresh code.
    if (!pairingSession.expired && !isRegistered(state)) {
      console.log('⚠️ تعذر إصدار رمز الربط الآن، تتم إعادة المحاولة تلقائياً…');
      log.debug({ code, error }, 'pairing request failed');
      scheduleReconnect(() => {}, PAIRING_RETRY_MS);
    }
  }
}

export async function startSocket(onReady) {
  const generation = ++bootGeneration;
  clearReconnectTimer();

  if (activeSocket) {
    try { activeSocket.ws?.close(); } catch {}
    activeSocket = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.windows('Chrome'),
    logger: log,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 20_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000
  });

  activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  if (!isRegistered(state)) {
    stopPairingTimer();
    pairingSession = {
      generation,
      requested: false,
      expired: false,
      code: null,
      issuedAt: 0,
      timer: setTimeout(() => {
        void expirePairingSession(sock, state, generation);
      }, PAIRING_WINDOW_MS)
    };
  }

  let readyCalled = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (generation !== bootGeneration) return;

    // The qr event is emitted in pairing-code mode too. This is the cleanest
    // official trigger for requestPairingCode.
    if (qr && !isRegistered(state) && pairingSession && !pairingSession.requested) {
      await requestPairingCodeSafely(sock, state, generation);
    }

    if (connection === 'open') {
      stopPairingTimer();
      clearReconnectTimer();
      readyCalled = true;

      console.log('\n🌋 VOLCANO ONLINE');
      console.log('🛡️ الحماية جاهزة.\n');

      if (onReady) await onReady(sock);
      return;
    }

    if (connection !== 'close') return;

    const code = statusCodeOf(lastDisconnect?.error);
    const registered = isRegistered(state);
    const loggedOut = code === DisconnectReason.loggedOut;
    const restartRequired = code === DisconnectReason.restartRequired;

    if (activeSocket === sock) activeSocket = null;

    // A paired account must never be treated as an expired pairing session.
    if (registered) {
      if (loggedOut) {
        stopPairingTimer();
        console.log('\n🔐 تم تسجيل خروج جلسة WhatsApp.');
        console.log('يرجى إعادة الربط عند الحاجة.\n');
        return;
      }

      console.log('⚡ اتصال WhatsApp انقطع — إعادة الاتصال تلقائياً…');
      scheduleReconnect(onReady, restartRequired ? 800 : 2_000);
      return;
    }

    // Unpaired socket: keep the 3-minute window alive. A transient close,
    // including 428/401 during pairing, must not kill Node.js.
    if (pairingSession?.expired) return;

    console.log('⚠️ اتصال جلسة الربط انقطع — محاولة اتصال جديدة ضمن مهلة 3 دقائق…');
    scheduleReconnect(onReady, restartRequired ? 800 : PAIRING_RETRY_MS);
  });

  return sock;
}
