const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { createClient } = require('redis');
const express = require('express');

ffmpeg.setFfmpegPath(ffmpegPath);

// ══════════════════════════════════════════
// اتصال Redis
// ══════════════════════════════════════════
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

// ══════════════════════════════════════════
// OTP - تخزين في Redis
// ══════════════════════════════════════════
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
async function saveOTP(phone, otp) {
    await redis.set(`otp:${phone}`, otp, { EX: 300 }); // 5 دقائق
}
async function getOTP(phone) {
    return await redis.get(`otp:${phone}`);
}
async function deleteOTP(phone) {
    await redis.del(`otp:${phone}`);
}

// ══════════════════════════════════════════
// عد الكلمات
// ══════════════════════════════════════════
function countWords(text) {
    if (!text || text.trim().length === 0) return 0;
    return text.trim().split(/\s+/).length;
}

// ══════════════════════════════════════════
// تحويل MP3 إلى OGG
// ══════════════════════════════════════════
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

// ══════════════════════════════════════════
// الدالة الرئيسية
// ══════════════════════════════════════════
// ══════════════════════════════════════════
// Express يبدأ فوراً قبل أي شيء (مطلوب من Railway)
// ══════════════════════════════════════════
const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/', (req, res) => {
    res.json({ status: '🦅 صقور العراق - OTP Service يعمل', time: new Date().toISOString() });
});

const OTP_SECRET = process.env.OTP_SECRET || 'suqoor_iraq_secret_2024';

app.post('/send-otp', async (req, res) => {
    const { phone, secret } = req.body;
    if (secret !== OTP_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!phone) return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const otp = generateOTP();
    try {
        await saveOTP(cleanPhone, otp);
        await globalSock.sendMessage(jid, {
            text: `🦅 *صقور العراق*

رمز التحقق الخاص بك:

*${otp}*

⏱️ صالح لمدة 5 دقائق
🔒 لا تشارك هذا الرمز مع أحد.`
        });
        console.log(`✅ OTP أُرسل إلى: ${cleanPhone}`);
        res.json({ success: true, message: 'OTP أُرسل بنجاح' });
    } catch (err) {
        console.log(`⚠️ فشل إرسال OTP: ${err.message}`);
        res.status(500).json({ success: false, error: 'فشل إرسال الرسالة' });
    }
});

app.post('/verify-otp', async (req, res) => {
    const { phone, otp, secret } = req.body;
    if (secret !== OTP_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!phone || !otp) return res.status(400).json({ success: false, error: 'رقم الهاتف والرمز مطلوبان' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const savedOTP = await getOTP(cleanPhone);
    if (!savedOTP) return res.status(400).json({ success: false, error: 'الرمز غير موجود أو انتهت صلاحيته' });
    if (savedOTP !== otp.toString()) return res.status(400).json({ success: false, error: 'الرمز غير صحيح' });
    await deleteOTP(cleanPhone);
    console.log(`✅ OTP تم التحقق: ${cleanPhone}`);
    res.json({ success: true, message: 'تم التحقق بنجاح' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 OTP API يعمل على port ${PORT}`);
});

// متغير عام للـ socket
let globalSock = null;

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
    globalSock = sock;

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

    // OTP API يعمل خارج startBot

    // ══════════════════════════════════════════
    // cache لمنع معالجة نفس الرسالة مرتين
    // ══════════════════════════════════════════
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

        // التاكات مسموحة للجميع
        const hasMention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0 || content.includes('@');
        if (hasMention) {
            console.log(`🔕 تجاهل تاك من: ${sender}`);
            return;
        }

        console.log(`📨 رسالة من ${sender}: "${content}"`);

        const warned = await isWarned(sender);

        if (!warned) {
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
            const hasAnyLink = /(https?:\/\/|www\.)[^\s]+/i.test(content);
            if (hasAnyLink) {
                console.log(`🔕 تجاهل رابط من: ${sender}`);
                return;
            }
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
