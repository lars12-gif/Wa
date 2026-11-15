import { config } from './config.js';
import { install, uninstall, info, all } from './store.js';

const normalizeJid = value => {
  if (!value) return '';
  const s = String(value);
  if (s.includes('@')) return s.split(':')[0] + s.slice(s.indexOf('@'));
  return `${s.split(':')[0]}@s.whatsapp.net`;
};

const parse = text => {
  if (!text?.startsWith(config.prefix)) return null;
  const [name, ...args] = text.slice(config.prefix.length).trim().split(/\s+/);
  return { name: (name || '').toLowerCase(), args };
};

export async function commands(sock, m) {
  const jid = m?.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return false;

  const body =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    '';

  const command = parse(body);
  if (!command) return false;

  // For messages sent by the linked account, participant is often absent.
  // sock.user.id is the authoritative local identity in that case.
  const actor = normalizeJid(
    m.key?.fromMe
      ? sock.user?.id
      : (m.key?.participantAlt || m.key?.participant)
  );

  const actorNumber = actor.split('@')[0];
  const isOwner = (config.owners || []).some(
    x => String(x).replace(/\D/g, '') === actorNumber
  );

  let isAdmin = false;
  try {
    const metadata = await sock.groupMetadata(jid);
    const participant = metadata.participants?.find(p => {
      const id = normalizeJid(p.id);
      const alt = normalizeJid(p.phoneNumber || p.lid);
      return (
        id === actor ||
        alt === actor ||
        id.split('@')[0] === actorNumber ||
        alt.split('@')[0] === actorNumber
      );
    });
    isAdmin = !!participant?.admin;
  } catch {
    // Fail closed: never grant group commands without role proof.
  }

  if (!isAdmin && !isOwner) {
    await sock.sendMessage(
      jid,
      { text: '⛔ هذا الأمر للمشرفين فقط.' },
      { quoted: m }
    );
    return true;
  }

  if (['تنصيب', 'install'].includes(command.name)) {
    await install(jid, actor);
    await sock.sendMessage(jid, {
      text:
        '🌋 VOLCANO\n\n🛡️ تم تفعيل الحماية لهذه المجموعة.\n' +
        'Contact Guard  •  ON\nAttack Guard  •  ON\nEmergency Lock  •  ON'
    });
    return true;
  }

  if (['الغاء', 'إلغاء', 'uninstall'].includes(command.name)) {
    await uninstall(jid);
    await sock.sendMessage(jid, { text: '🌋 تم إلغاء حماية هذه المجموعة.' });
    return true;
  }

  if (['حالة', 'status'].includes(command.name)) {
    await sock.sendMessage(jid, {
      text: info(jid)
        ? '🌋 VOLCANO\nالحماية: 🟢 مفعّلة'
        : '🌋 VOLCANO\nالحماية: ⚪ غير مفعّلة'
    });
    return true;
  }

  if (['مساعدة', 'help'].includes(command.name)) {
    await sock.sendMessage(jid, {
      text:
        '🌋 VOLCANO — الأوامر\n\n' +
        '.تنصيب  تفعيل الحماية\n' +
        '.إلغاء  إيقاف الحماية\n' +
        '.حالة  حالة المجموعة\n' +
        '.مساعدة  عرض الأوامر'
    });
    return true;
  }

  if (command.name === 'المجموعات' && isOwner) {
    const groups = all();
    await sock.sendMessage(jid, {
      text:
        `🌋 المجموعات المحمية: ${groups.length}\n\n` +
        groups.map((g, i) => `${i + 1}. ${g.jid}`).join('\n')
    });
    return true;
  }

  return false;
}
