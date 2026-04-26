const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { createClient } = require('redis');

// ضبط مسار ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// --- اتصال Redis ---
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.log('⚠️ Redis Error:', err));

// --- دوال الذاكرة عبر Redis ---
async function isWarned(sender) {
    const result = await redis.get(`warned:${sender}`);
    return result !== null;
}

async function addWarned(sender) {
    await redis.set(`warned:${sender}`, '1');
}

// --- دالة تحويل MP3 إلى OGG/Opus ---
function convertToOgg(inputPath) {
    const outputPath = inputPath.replace('.mp3', '_converted.ogg');
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outputPath)) {
            return resolve(outputPath);
        }
        ffmpeg(inputPath)
            .audioCodec('libopus')
            .audioBitrate('128k')
            .format('ogg')
            .on('end', () => {
                console.log('✅ تم تحويل الملف الصوتي بنجاح.');
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.log('⚠️ فشل تحويل الصوت:', err.message);
                reject(err);
            })
            .save(outputPath);
    });
}

async function startBot() {
    // --- الاتصال بـ Redis ---
    await redis.connect();
    console.log('✅ تم الاتصال بـ Redis بنجاح!');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    // --- تحويل الملف الصوتي مرة واحدة عند بدء التشغيل ---
    let oggPath = null;
    if (fs.existsSync('./voice.mp3')) {
        try {
            oggPath = await convertToOgg('./voice.mp3');
            console.log(`🎵 الملف الصوتي جاهز: ${oggPath}`);
        } catch (err) {
            console.log('⚠️ تعذّر تحويل الملف الصوتي.');
        }
    } else {
        console.log('⚠️ ملف voice.mp3 غير موجود!');
    }

    // --- طلب كود الربط ---
    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433";
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n\n************************************`);
                console.log(`✅ كود الربط: ${code}`);
                console.log(`************************************\n\n`);
            } catch (err) {
                console.log("⚠️ فشل طلب الكود.");
            }
        }, 8000);
    }

    sock.ev.on('creds.update', saveCreds);

    // --- معالجة الرسائل ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@g.us')) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const type = Object.keys(msg.message)[0];
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // فحص نوع الرسالة
        const isMedia = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(type);
        const hasMention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0 || content.includes('@');
        const isEmojiOnly = /^[\p{Emoji}\s\p{Punctuation}]+$/u.test(content.trim());
        const isTextMessage = (type === 'conversation' || type === 'extendedTextMessage') && !isMedia && !hasMention && !isEmojiOnly && content.trim().length > 0;

        if (!isTextMessage) return;

        const warned = await isWarned(sender);

        if (!warned) {
            // ══════════════════════════════════════════
            // أول رسالة كتابية → إرسال البصمة + الحفظ في Redis
            // ══════════════════════════════════════════
            await addWarned(sender);
            console.log(`📝 تم حفظ العضو في Redis: ${sender}`);

            if (oggPath && fs.existsSync(oggPath)) {
                try {
                    await sock.sendMessage(from, {
                        audio: fs.readFileSync(oggPath),
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,
                        contextInfo: {
                            mentionedJid: [sender],
                            quotedMessage: msg.message
                        }
                    }, { quoted: msg });
                    console.log(`🎙️ تم إرسال البصمة الصوتية لـ: ${sender}`);
                } catch (err) {
                    console.log(`⚠️ فشل إرسال الصوت: ${err.message}`);
                }
            }

        } else {
            // ══════════════════════════════════════════
            // سبق وأخذ البصمة → حذف رسالته فوراً
            // ══════════════════════════════════════════
            try {
                await sock.sendMessage(from, { delete: msg.key });
                console.log(`🗑️ تم حذف رسالة العضو المحفوظ: ${sender}`);
            } catch (err) {
                console.log("⚠️ فشل الحذف (تأكد أن البوت مشرف).");
            }
        }
    });

    // --- إعادة الاتصال التلقائي ---
    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect } = up;
        if (connection === 'open') {
            console.log('🦅 صقور العراق: البوت متصل الآن!');
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
