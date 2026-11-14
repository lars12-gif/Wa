import fs from 'node:fs/promises';
import { config } from './config.js';
import { installed } from './store.js';

const seen = new Map();
const lockTimers = new Map();
const isGroup = m => m?.key?.remoteJid?.endsWith('@g.us');
const isContact = m => !!(m?.message?.contactMessage || m?.message?.contactsArrayMessage);
const sender = m => m?.key?.participant || m?.participant || null;
const countContacts = m => m?.message?.contactsArrayMessage?.contacts?.length || (m?.message?.contactMessage ? 1 : 0);

function duplicate(id) {
  const now = Date.now();
  const previous = seen.get(id);
  if (previous && now - previous < 30_000) return true;
  seen.set(id, now);
  if (seen.size > 5000) for (const [key, time] of seen) if (now - time > 60_000) seen.delete(key);
  return false;
}
async function kick(sock, jid, participant) {
  try { await sock.groupParticipantsUpdate(jid, [participant], 'remove'); return true; }
  catch { return false; }
}
async function removeMessage(sock, key) {
  try { await sock.sendMessage(key.remoteJid, { delete: key }); return true; }
  catch { return false; }
}
async function lockGroup(sock, jid) {
  try { await sock.groupSettingUpdate(jid, 'announcement'); return true; }
  catch { return false; }
}
async function unlockGroup(sock, jid) {
  try { await sock.groupSettingUpdate(jid, 'not_announcement'); }
  catch { /* group may have been changed manually or permissions revoked */ }
}

export async function protect(sock, message) {
  const jid = message?.key?.remoteJid;
  if (!isGroup(message) || !installed(jid) || !isContact(message) || message.key?.fromMe) return false;
  const messageId = message.key?.id;
  if (!messageId || duplicate(`${jid}:${messageId}`)) return true;

  const participant = sender(message);
  const result = { kicked: false, deleted: false, locked: false };

  // Strict requested order. Do not wait for groupMetadata or disk I/O here.
  if (participant) result.kicked = await kick(sock, jid, participant);
  result.deleted = await removeMessage(sock, message.key);
  result.locked = await lockGroup(sock, jid);

  const previous = lockTimers.get(jid);
  if (previous) clearTimeout(previous);
  lockTimers.set(jid, setTimeout(() => {
    void unlockGroup(sock, jid);
    lockTimers.delete(jid);
  }, config.lockMs));

  if (config.securityMessages) void sendNotice(sock, jid, result, countContacts(message));
  return true;
}

async function sendNotice(sock, jid, result, count) {
  const text = [
    '🔥 فولكانو — تم صد هجوم', '',
    `📇 البطاقات المكتشفة: ${count}`,
    `🚫 طرد المرسل: ${result.kicked ? 'تم' : 'تعذر'}`,
    `🗑️ حذف الرسالة: ${result.deleted ? 'تم' : 'تعذر'}`,
    `🔒 قفل المجموعة: ${result.locked ? 'تم' : 'تعذر'}`,
    '', '🌋 VOLCANO SECURITY'
  ].join('\n');
  try {
    if (config.sendSecurityImage) {
      const image = await fs.readFile(config.image);
      await sock.sendMessage(jid, { image, caption: text });
    } else await sock.sendMessage(jid, { text });
  } catch { /* notification is secondary; never block protection */ }
}

export { isGroup, isContact };
