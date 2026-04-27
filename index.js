const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { createClient } = require('redis');

ffmpeg.setFfmpegPath(ffmpegPath);

// --- اتصال Redis ---
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.log('⚠️ Redis Error:', err));

async function isWarned(sender) {
    try {
        const result = await redis.get(`warned:${sender}`);
        return result !== null;
    } catch (e) { return false; }
}

async function addWarned(sender) {
    try {
        await redis.set(`warned:${sender}`, '1', { EX: 604800 });
    } catch (e) { console.log('⚠️ فشل الحفظ في Redis'); }
}

// --- عد الكلمات ---
function countWords(text) {
    if (!text || text.trim().length === 0) return 0;
    return text.trim().split(/\s+/).length;
}

// --- تحويل MP3 إلى OGG ---
function convertToOgg(inputPath) {
    const outputPath = inputPath.replace('.mp3', '_converted.ogg');
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outputPath)) return resolve(outputPath);
        ffmpeg(inputPath)
            .audioCodec('libopus')
            .audioBitrate('128k')
            .format('ogg')
            .on('end', () => { console.log('✅ تم تحويل الصوت.'); resolve(outputPath); })
            .on('error', (err) => { console.log('⚠️ فشل التحويل:', err.message); reject(err); })
            .save(outputPath);
    });
}

async function startBot() {
    await redis.connect();
    console.log('✅ Redis متصل!');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    let oggPath = null;
    if (fs.existsSync('./voice.mp3')) {
        try {
            oggPath = await convertToOgg('./voice.mp3');
            console.log(`🎵 الصوت جاهز: ${oggPath}`);
        } catch (err) { console.log('⚠️ تعذّر تحويل الصوت.'); }
    } else {
        console.log('⚠️ voice.mp3 غير موجود!');
    }

    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433";
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n************************************`);
                console.log(`✅ كود الربط: ${code}`);
                console.log(`************************************\n`);
            } catch (err) { console.log("⚠️ فشل طلب الكود."); }
        }, 8000);
    }

    sock.ev.on('creds.update', saveCreds);

    // cache لمنع معالجة نفس الرسالة مرتين
    const processedMessages = new Set();

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@g.us')) return;

        const msgId = msg.key.id;
        if (processedMessages.has(msgId)) return;
        processedMessages.add(msgId);
        if (processedMessages.size > 1000) processedMessages.clear();

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const type = Object.keys(msg.message)[0];
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // ══════════════════════════════════════════
        // معالجة الصور (imageMessage)
        // ══════════════════════════════════════════
        if (type === 'imageMessage') {
            const caption = msg.message.imageMessage?.caption || "";
            const wordCount = countWords(caption);
            console.log(`🖼️ صورة من ${sender} - عدد الكلمات: ${wordCount}`);
            if (wordCount > 10) {
                try {
                    await sock.sendMessage(from, { delete: msg.key });
                    console.log(`🗑️ حذف صورة (+10 كلمة) من: ${sender}`);
                } catch (err) { console.log("⚠️ فشل الحذف."); }
            } else if (wordCount > 5) {
                if (oggPath && fs.existsSync(oggPath)) {
                    try {
                        await sock.sendMessage(from, {
                            audio: fs.readFileSync(oggPath),
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true,
                        }, { quoted: msg });
                        console.log(`🎙️ بصمة صوتية لصورة (+5 كلمة) من: ${sender}`);
                    } catch (err) { console.log(`⚠️ فشل إرسال الصوت: ${err.message}`); }
                }
            }
            return;
        }

        // ══════════════════════════════════════════
        // معالجة الرسائل النصية
        // ══════════════════════════════════════════
        const isMedia = ['videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(type);
        if (isMedia) return;

        const isText = type === 'conversation' || type === 'extendedTextMessage';
        if (!isText) return;

        if (!content || content.trim().length === 0) return;

        // ✅ التاكات مسموحة للجميع (mentionedJid أو @ في النص)
        const hasMention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0 || content.includes('@');
        if (hasMention) {
            console.log(`🔕 تجاهل تاك من: ${sender}`);
            return;
        }

        console.log(`📨 رسالة من ${sender}: "${content}"`);

        const warned = await isWarned(sender);

        if (!warned) {
            // شخص جديد → بصمة أولاً ثم الحفظ
            console.log(`🆕 مستخدم جديد: ${sender} → إرسال البصمة`);
            if (oggPath && fs.existsSync(oggPath)) {
                try {
                    await sock.sendMessage(from, {
                        audio: fs.readFileSync(oggPath),
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,
                    }, { quoted: msg });
                    console.log(`🎙️ تم إرسال البصمة لـ: ${sender}`);
                } catch (err) { console.log(`⚠️ فشل إرسال الصوت: ${err.message}`); }
            }
            await addWarned(sender);

        } else {
            // ✅ تجاهل أي رسالة تحتوي رابط
            const hasAnyLink = /(https?:\/\/|www\.)[^\s]+/i.test(content);
            if (hasAnyLink) {
                console.log(`🔕 تجاهل رابط من: ${sender}`);
                return;
            }

            // شخص محفوظ → حذف فوري
            console.log(`🗑️ حذف رسالة ${sender} (محفوظ مسبقاً)`);
            try {
                await sock.sendMessage(from, { delete: msg.key });
            } catch (err) { console.log("⚠️ فشل الحذف - تأكد أن البوت مشرف."); }
        }
    });

    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect } = up;
        if (connection === 'open') console.log('🦅 صقور العراق: البوت متصل!');
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                console.log('🔄 إعادة الاتصال...');
                startBot();
            }
        }
    });
}

startBot();
