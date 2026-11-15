import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { config } from './config.js';

const groupsFile = path.join(config.dataDir, 'groups.json');
const messagesFile = path.join(config.dataDir, 'messages.jsonl');
let db = { groups: {} };
let writeChain = Promise.resolve();
let journal = null;

export async function initStore() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    db = JSON.parse(await fs.readFile(groupsFile, 'utf8'));
    if (!db || typeof db !== 'object' || typeof db.groups !== 'object') db = { groups: {} };
  } catch {
    await saveGroups();
  }

  journal = createWriteStream(messagesFile, {
    flags: 'a',
    highWaterMark: 64 * 1024
  });
  journal.on('error', error => console.error('[DATABASE]', error.message));
}

async function saveGroups() {
  const temp = `${groupsFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(db, null, 2));
  await fs.rename(temp, groupsFile);
}

const persist = () => {
  writeChain = writeChain.then(saveGroups, saveGroups);
  return writeChain;
};

export const installed = jid => !!db.groups?.[jid]?.enabled;

export async function install(jid, by) {
  db.groups[jid] = { enabled: true, by, at: new Date().toISOString() };
  await persist();
  return db.groups[jid];
}

export async function uninstall(jid) {
  delete db.groups[jid];
  await persist();
}

export const info = jid => db.groups?.[jid] || null;

export const all = () =>
  Object.entries(db.groups || {})
    .filter(([, value]) => value?.enabled)
    .map(([jid, value]) => ({ jid, ...value }));

// Keep the journal lightweight. Storing the complete Baileys message object here
// can retain large media/metadata objects and create unnecessary memory pressure.
export function recordMessage(message) {
  if (!journal) return;

  const record = {
    id: message?.key?.id || null,
    chat: message?.key?.remoteJid || null,
    sender: message?.key?.participantAlt || message?.key?.participant || (message?.key?.fromMe ? 'self' : null),
    fromMe: !!message?.key?.fromMe,
    timestamp: message?.messageTimestamp || Math.floor(Date.now() / 1000),
    type: Object.keys(message?.message || {})[0] || null,
    protectedGroup: installed(message?.key?.remoteJid),
    receivedAt: new Date().toISOString()
  };

  // Do not retain the full message payload in the journal.
  journal.write(`${JSON.stringify(record)}\n`);
}
