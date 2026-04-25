const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

// منع Railway من إيقاف البوت أثناء الربط
process.on('SIGTERM', () => console.log('⚠️ SIGTERM — البوت يستمر...'));
process.on('SIGINT', () => console.log('⚠️ SIGINT — البوت يستمر...'));
process.on('uncaughtException', (err) => console.log('⚠️ خطأ غير متوقع:', err.message));

// --- نظام الذاكرة للمستخدمين الذين تم تنبيههم ---
const WARNED_FILE = './warned.json';
let warnedUsers = new Set();

if (fs.existsSync(WARNED_FILE)) {
    try {
        const data = fs.readFileSync(WARNED_FILE);
        warnedUsers = new Set(JSON.parse(data));
        console.log(`✅ تم تحميل ذاكرة الصيادين: ${warnedUsers.size} مستخدم.`);
    } catch (e) { console.log("⚠️ خطأ في قراءة ملف الذاكرة."); }
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

    // --- طلب كود الربط مع إعادة المحاولة ---
    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433";
        setTimeout(async () => {
            let attempts = 0;
            while (attempts < 10) {
                try {
                    let code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n====================================`);
                    console.log(`✅ كود الربط الخاص بك:`);
                    console.log(`\n`);
                    for (const char of code) {
                        console.log(char);
                    }
                    console.log(`\n`);
                    console.log(`الكود كاملاً: ` + code.split('').join(' '));
                    console.log(`====================================\n`);
                    console.log(`⏳ عندك 60 ثانية لإدخال الكود...`);
                    await delay(60000);
                    attempts++;
                } catch (err) {
                    attempts++;
                    console.log(`⚠️ محاولة ${attempts} فشلت، إعادة بعد 10 ثواني...`);
                    await delay(10000);
                }
            }
            if (attempts === 10) {
                console.log("❌ فشلت جميع المحاولات. أعد تشغيل البوت.");
            }
        }, 5000);
    }

    sock.ev.on('creds.update', saveCreds);

    // --- معالجة الرسائل الواردة ---
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
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,
                        contextInfo: {
                            mentionedJid: [sender],
                            quotedMessage: msg.message
                        }
                    }, { quoted: msg });
                    console.log(`🎙️ تم إرسال التنبيه الصوتي لـ: ${sender}`);
                }
            } else {
                try {
                    await sock.sendMessage(from, { delete: msg.key });
                    console.log(`🗑️ تم حذف رسالة مخالف مكرر: ${sender}`);
                } catch (err) { console.log("⚠️ فشل الحذف (قد لا أكون مشرفاً)."); }
            }
        }
    });

    // --- إعادة الاتصال التلقائي ---
    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect } = up;
        if (connection === 'open') {
            console.log('🦅 صقور العراق: البوت متصل الآن بنجاح!');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                console.log('🔄 انقطع الاتصال، جاري إعادة المحاولة...');
                startBot();
            }
        }
    });
}

startBot();
