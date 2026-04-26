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
    } catch (e) {
        return false;
    }
}

async function addWarned(sender) {
    try {
        await redis.set(`warned:${sender}`, '1');
    } catch (e) {
        console.log('⚠️ فشل الحفظ في Redis');
    }
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

// --- فحص إذا الرسالة نصية حقيقية ---
function isRealText(content, type, msg) {
    // لازم يكون نوعها نص
    if (type !== 'conversation' && type !== 'extendedTextMessage') return false;
    // لازم فيها محتوى
    if (!content || content.trim().length === 0) return false;
    // لازم ما تكون منشن
    const hasMention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0 || content.includes('@');
    if (hasMention) return false;
    // لازم تحتوي على حرف عربي أو إنجليزي أو رقم (مو إيموجي فقط)
    const hasRealChar = /[\u0600-\u06FFa-zA-Z0-9]/.test(content);
    if (!hasRealChar) return false;
    return true;
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

    // --- تحويل الصوت عند بدء التشغيل ---
    let oggPath = null;
    if (fs.existsSync('./voice.mp3')) {
        try {
            oggPath = await convertToOgg('./voice.mp3');
            console.log(`🎵 الصوت جاهز: ${oggPath}`);
        } catch (err) {
            console.log('⚠️ تعذّر تحويل الصوت.');
        }
    } else {
        console.log('⚠️ voice.mp3 غير موجود!');
    }

    // --- كود الربط ---
    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433";
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n************************************`);
                console.log(`✅ كود الربط: ${code}`);
                console.log(`************************************\n`);
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

        // ميديا = تجاهل
        const isMedia = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(type);
        if (isMedia) return;

        // إذا مو رسالة نصية حقيقية = تجاهل
        if (!isRealText(content, type, msg)) return;

        console.log(`📨 رسالة من ${sender}: "${content}"`);

        // --- تحقق أولاً هل هو محفوظ أم لا ---
        const warned = await isWarned(sender);

        if (!warned) {
            // ══════════════════════════════
            // أول رسالة → بصمة صوتية + حفظ
            // ══════════════════════════════
            console.log(`🆕 مستخدم جديد: ${sender} → إرسال البصمة`);
            
            // احفظه أولاً لمنع التكرار
            await addWarned(sender);

            if (oggPath && fs.existsSync(oggPath)) {
                try {
                    await sock.sendMessage(from, {
                        audio: fs.readFileSync(oggPath),
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,
                    }, { quoted: msg });
                    console.log(`🎙️ تم إرسال البصمة لـ: ${sender}`);
                } catch (err) {
                    console.log(`⚠️ فشل إرسال الصوت: ${err.message}`);
                }
            } else {
                console.log('⚠️ ملف الصوت غير متاح!');
            }

        } else {
            // ══════════════════════════════
            // محفوظ مسبقاً → حذف فوري
            // ══════════════════════════════
            console.log(`🗑️ حذف رسالة ${sender} (محفوظ مسبقاً)`);
            try {
                await sock.sendMessage(from, { delete: msg.key });
            } catch (err) {
                console.log("⚠️ فشل الحذف - تأكد أن البوت مشرف.");
            }
        }
    });

    // --- إعادة الاتصال ---
    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect } = up;
        if (connection === 'open') {
            console.log('🦅 صقور العراق: البوت متصل!');
        }
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
