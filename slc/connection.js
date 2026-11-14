import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'node:fs/promises';
import { config } from './config.js';

const log = pino({ level: config.logLevel });
let generation = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Starts one WhatsApp socket.
 * Pairing code is requested only after Baileys has emitted its initial
 * connection/QR event. Calling requestPairingCode immediately after
 * makeWASocket can race the WebSocket startup and produce 428 Connection Closed.
 */
export async function startSocket(onReady) {
  const myGen = ++generation;
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Volcano Security'),
    logger: log,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 30_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: undefined
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingTimer = null;
  let pairingRequested = false;
  let pairingExpired = false;
  let readyCalled = false;

  const cleanupUnpairedAuth = async () => {
    try {
      await fs.rm(config.authDir, { recursive: true, force: true });
      await fs.mkdir(config.authDir, { recursive: true });
      log.info('temporary unpaired auth state cleaned');
    } catch (err) {
      log.error({ err }, 'failed to clean temporary auth');
    }
  };

  const closeExpiredPairing = async () => {
    if (pairingExpired || state.creds.registered) return;
    pairingExpired = true;
    log.warn('pairing window expired after 3 minutes; closing unpaired session');
    try {
      await sock.logout();
    } catch (err) {
      log.debug({ err }, 'logout during pairing expiry failed; socket will remain closed from supervisor');
    }
    await cleanupUnpairedAuth();
  };

  if (!state.creds.registered) {
    if (!config.phone) {
      throw new Error('PHONE_NUMBER is required for first pairing');
    }

    pairingTimer = setTimeout(() => {
      void closeExpiredPairing();
    }, config.pairingTimeoutMs);
  }

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    // Baileys documentation recommends waiting for the initial connection/QR
    // event before requesting the pairing code. The small delay avoids the
    // 428 race seen when the WebSocket is not ready yet.
    if (!state.creds.registered && !pairingRequested && !pairingExpired && (connection === 'connecting' || qr)) {
      pairingRequested = true;
      await sleep(2500);

      if (state.creds.registered || pairingExpired) return;

      try {
        const code = await sock.requestPairingCode(config.phone);
        log.info('pairing code generated successfully');
        console.log(`\n🌋 VOLCANO PAIRING CODE: ${code}\n⏳ صالح لمدة 3 دقائق فقط.\n`);
      } catch (err) {
        pairingRequested = false;
        log.error({ err }, 'pairing code request failed; retrying after socket startup settles');
        // Do not crash the whole process because the first pairing request
        // raced the connection. A later connection.update will retry.
        setTimeout(() => {
          if (!state.creds.registered && !pairingExpired && !pairingRequested) {
            pairingRequested = false;
          }
        }, 3000);
      }
    }

    if (connection === 'open') {
      if (pairingTimer) {
        clearTimeout(pairingTimer);
        pairingTimer = null;
      }
      pairingExpired = false;
      if (!readyCalled) {
        readyCalled = true;
        log.info('🔥 VOLCANO ONLINE — SECURITY READY');
        await onReady(sock);
      }
    }

    if (connection === 'close') {
      if (pairingTimer) {
        clearTimeout(pairingTimer);
        pairingTimer = null;
      }

      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const restart = code === DisconnectReason.restartRequired;

      if (myGen !== generation) return;

      // An intentionally expired unpaired session must not reconnect itself.
      if (pairingExpired) {
        log.info('unpaired pairing session closed; waiting for manual restart');
        return;
      }

      if (!loggedOut) {
        log.warn({ code, restart }, 'socket closed; reconnecting');
        setTimeout(() => {
          startSocket(onReady).catch(err => log.error({ err }, 'reconnect failed'));
        }, restart ? 500 : 1500);
      } else {
        log.error('WhatsApp session logged out; manual pairing is required');
      }
    }
  });

  return sock;
}
