const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

async function startBot() {
    // التعديل هنا: استخدام مجلد محلي لضمان بقاء الجلسة حتى لو طفأ السيرفر
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "22.0.01"] // تغيير المتصفح لتجنب حظر واتساب
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433"; // رقمك كما طلبت
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n\n✅ كود الربط الجديد هو: ${code}\n\n`);
            } catch (err) {
                console.log("⚠️ السيرفر يحاول طلب كود جديد...");
            }
        }, 10000); // زيادة وقت الانتظار لـ 10 ثوانٍ لضمان استقرار السيرفر
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@g.us')) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid; 
        const type = Object.keys(msg.message)[0];
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // فحص المخالفات والحذف الرد الصوتي
        if ((type === 'conversation' || type === 'extendedTextMessage') && content.trim().length > 0) {
            // (باقي كود الحذف والرد الصوتي الذي أعددناه سابقاً)
            if (fs.existsSync('./voice.mp3')) {
                await sock.sendMessage(from, { audio: { url: "./voice.mp3" }, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            }
        }
    });

    sock.ev.on('connection.update', (up) => {
        if (up.connection === 'open') console.log('🦅 صقور العراق: البوت شغال الآن!');
        if (up.connection === 'close') startBot();
    });
}

startBot();
