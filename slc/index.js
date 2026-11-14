import 'dotenv/config';
import { initStore } from './store.js';
import { startSocket } from './connection.js';
import { commands } from './commands.js';
import { protect, isGroup } from './security.js';

await initStore();

let wired = null;

async function wire(sock) {
  if (wired === sock) return;
  wired = sock;

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        if (!message?.message || message.key?.fromMe || !isGroup(message)) continue;
        if (await commands(sock, message)) continue;
        await protect(sock, message);
      } catch (err) {
        console.error('[MESSAGE]', err?.stack || err);
      }
    }
  });
}

process.on('uncaughtException', err => console.error('[UNCAUGHT]', err?.stack || err));
process.on('unhandledRejection', err => console.error('[UNHANDLED]', err?.stack || err));

async function boot() {
  try {
    await startSocket(wire);
  } catch (err) {
    console.error('[BOOT]', err?.stack || err);
    // Keep the service alive and retry only for startup errors. Pairing
    // timeout itself intentionally does not trigger an automatic re-pair.
    setTimeout(() => void boot(), 5000);
  }
}

await boot();
