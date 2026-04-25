const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const WARNED_FILE = './warned.json';
let warnedUsers = new Set();

if (fs.existsSync(WARNED_FILE)) {
    try {
        const data = fs.readFileSync(WARNED_FILE);
        warnedUsers = new Set(JSON.parse(data));
        console.log(`✅ تم تحميل ذاكرة الصيادين.`);
    } catch (e) { console.log("⚠️ خطأ في الذاكرة."); }
}

function saveWarnedUsers() {
    fs.writeFileSync(WARNED_FILE, JSON.stringify([...warnedUsers]));
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433"; 
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n✅ كود الربط: ${code}\n`);
            } catch (err) { console.log("⚠️ خطأ طلب الكود."); }
        }, 5000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@g.us')) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid; 
        const type = Object.keys(msg.message)[0];
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        const isMedia = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(type);
        const hasMention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0 || content.includes('@');
        const isEmojiOnly = /^[\p{Emoji}\s\p{Punctuation}]+$/u.test(content.trim());

        if ((type === 'conversation' || type === 'extendedTextMessage') && !isMedia && !hasMention && !isEmojiOnly && content.trim().length > 0) {
            
            if (!warnedUsers.has(sender)) {
                warnedUsers.add(sender);
                saveWarnedUsers();

                if (fs.existsSync('./voice.mp3')) {
                    await sock.sendMessage(from, { 
                        audio: { url: "./voice.mp3" }, 
                        mimetype: 'audio/ogg; codecs=opus', // التعديل الذهبي لضمان التشغيل
                        ptt: true,
                        contextInfo: { 
                            mentionedJid: [sender],
                            quotedMessage: msg.message 
                        } 
                    }, { quoted: msg });
                }
            } else {
                try {
                    await sock.sendMessage(from, { delete: msg.key });
                } catch (err) { console.log("⚠️ فشل الحذف."); }
            }
        }
    });

    sock.ev.on('connection.update', (up) => {
        if (up.connection === 'open') console.log('🦅 صقور العراق متصل!');
        if (up.connection === 'close') startBot();
    });
}

startBot();
