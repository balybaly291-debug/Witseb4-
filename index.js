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
        // TTL = 7 أيام (604800 ثانية) - غيّرها حسب رغبتك
        await redis.set(`warned:${sender}`, '1', { EX: 604800 });
    } catch (e) { console.log('⚠️ فشل الحفظ في Redis'); }
}

// --- فحص إذا الرابط من فيسبوك أو تيك توك ---
function isFbOrTiktok(text) {
    return /(facebook\.com|fb\.com|fb\.watch|tiktok\.com|vm\.tiktok\.com)/i.test(text);
}

// --- فحص إذا الرسالة تحتوي رابط عادي (غير فيسبوك وتيك توك) ---
function hasLink(text) {
    if (isFbOrTiktok(text)) return false;
    const linkRegex = /(https?:\/\/|www\.)[^\s]+|[^\s]+\.(com|net|org|io|ly|me|app|co|gg|tv|ru|uk|de|fr|ar|iq|sa|ae|eg)[^\s]*/gi;
    return linkRegex.test(text);
}

// --- عد الكلمات ---
function countWords(text) {
    if (!text || text.trim().length === 0) return 0;
    return text.trim().split(/\s+/).length;
}

// --- فحص إذا الرسالة نصية حقيقية ---
function isRealText(content, type, msg) {
    if (type !== 'conversation' && type !== 'extendedTextMessage') return false;
    if (!content || content.trim().length === 0) return false;
    const hasMention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0 || content.includes('@');
    if (hasMention) return false;
    if (hasLink(content)) return false;
    const hasRealChar = /[\u0600-\u06FFa-zA-Z0-9]/.test(content);
    if (!hasRealChar) return false;
    return true;
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

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@g.us')) return;

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
                // أكثر من 10 كلمات → حذف فوري
                try {
                    await sock.sendMessage(from, { delete: msg.key });
                    console.log(`🗑️ حذف صورة (+10 كلمة) من: ${sender}`);
                } catch (err) { console.log("⚠️ فشل الحذف."); }

            } else if (wordCount > 5) {
                // أكثر من 5 كلمات → بصمة صوتية
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
            // أقل من 5 كلمات → تجاهل
            return;
        }

        // ══════════════════════════════════════════
        // معالجة الرسائل النصية
        // ══════════════════════════════════════════
        const isMedia = ['videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(type);
        if (isMedia) return;

        // تجاهل إذا مو نص أصلاً
        const isText = type === 'conversation' || type === 'extendedTextMessage';
        if (!isText) return;

        // تجاهل إذا محتوى فارغ
        if (!content || content.trim().length === 0) return;

        console.log(`📨 رسالة من ${sender}: "${content}" | type: ${type}`);

        const warned = await isWarned(sender);

        if (!warned) {
            // شخص جديد → إرسال البصمة على أي رسالة نصية بدون تصفية
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

            // الحفظ بعد الإرسال
            await addWarned(sender);

        } else {
            // شخص محفوظ → حذف أي رسالة يكتبها بدون استثناء
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
