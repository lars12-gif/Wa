import 'dotenv/config';
import { initStore, recordMessage } from './store.js';
import { startSocket } from './connection.js';
import { commands } from './commands.js';
import { protect, isGroup } from './security.js';

await initStore();

let wiredSocket = null;

// Bounded per-group queue. The old implementation spawned an unbounded
// `void processMessage()` for every incoming message. During a message burst
// those pending promises retained message objects and could push the process
// over a 256MB hosting limit.
const queues = new Map();
const MAX_QUEUE_PER_GROUP = 40;
const MAX_ACTIVE_GROUPS = 8;
let activeGroups = 0;

async function drain(jid) {
  const queue = queues.get(jid);
  if (!queue || queue.running) return;

  queue.running = true;
  activeGroups++;

  try {
    while (queue.items.length) {
      const message = queue.items.shift();
      try {
        if (!(await commands(queue.sock, message))) {
          await protect(queue.sock, message);
        }
      } catch (error) {
        console.error('[MESSAGE]', error?.message || 'تعذر معالجة الرسالة');
      }
    }
  } finally {
    queue.running = false;
    activeGroups--;
    if (!queue.items.length) queues.delete(jid);

    // Start another queued group if one is waiting for a concurrency slot.
    schedule();
  }
}

function schedule() {
  if (activeGroups >= MAX_ACTIVE_GROUPS) return;

  for (const [jid, queue] of queues) {
    if (activeGroups >= MAX_ACTIVE_GROUPS) break;
    if (!queue.running && queue.items.length) void drain(jid);
  }
}

function enqueue(sock, message) {
  const jid = message?.key?.remoteJid;
  if (!jid) return;

  let queue = queues.get(jid);
  if (!queue) {
    queue = { sock, items: [], running: false };
    queues.set(jid, queue);
  }

  // Never let a burst create an unbounded in-memory backlog.
  if (queue.items.length >= MAX_QUEUE_PER_GROUP) {
    queue.items.shift();
    console.warn(`[QUEUE] dropped oldest pending message for ${jid}`);
  }

  queue.items.push(message);
  schedule();
}

async function wire(sock) {
  if (wiredSocket === sock) return;
  wiredSocket = sock;

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages || []) {
      if (!message?.message || !isGroup(message)) continue;
      recordMessage(message);
      enqueue(sock, message);
    }
  });
}

process.on('uncaughtException', error =>
  console.error('[FATAL]', error?.message || 'خطأ غير متوقع')
);
process.on('unhandledRejection', error =>
  console.error('[ASYNC]', error?.message || 'خطأ غير متوقع')
);

async function boot() {
  try {
    await startSocket(wire);
  } catch (error) {
    console.error('[STARTUP]', error?.message || 'تعذر بدء الاتصال');
    setTimeout(() => void boot(), 5000);
  }
}

await boot();
