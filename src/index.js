import 'dotenv/config';
import { initStore, recordMessage } from './store.js';
import { startSocket } from './connection.js';
import { commands } from './commands.js';
import { protect, isGroup } from './security.js';

await initStore();
let wiredSocket = null;

async function processMessage(sock, message) {
  try {
    if (await commands(sock, message)) return;
    await protect(sock, message);
  } catch (error) {
    console.error('[MESSAGE]', error?.message || 'تعذر معالجة الرسالة');
  }
}

async function wire(sock) {
  if (wiredSocket === sock) return;
  wiredSocket = sock;
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages || []) {
      if (!message?.message || !isGroup(message)) continue;
      recordMessage(message);
      // Independent tasks prevent one slow message from blocking later ones.
      void processMessage(sock, message);
    }
  });
}

process.on('uncaughtException', error => console.error('[FATAL]', error?.message || 'خطأ غير متوقع'));
process.on('unhandledRejection', error => console.error('[ASYNC]', error?.message || 'خطأ غير متوقع'));

async function boot() {
  try { await startSocket(wire); }
  catch (error) {
    console.error('[STARTUP]', error?.message || 'تعذر بدء الاتصال');
    setTimeout(() => void boot(), 5000);
  }
}
await boot();
