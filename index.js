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

// --- حذف فوري ---
async function deleteMessage(sock, from, msgKey) {
    try {
        await sock.sendMessage(from, { delete: msgKey });
        console.log(`🗑️ تم الحذف`);
    } catch (err) {
        console.log(`⚠️ فشل الحذف: ${err.message}`);
    }
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

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@g.us')) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const type = Object.keys(msg.message)[0];
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // ✅ أرقام المشرفين - لا تُحذف رسائلهم أبداً
        const ADMINS = ["9647877132433@s.whatsapp.net"];
        if (ADMINS.includes(sender)) return;

        // فقط رسائل نصية
        const isText = type === 'conversation' || type === 'extendedTextMessage';
        if (!isText) {
            console.log(`⛔ تجاهل نوع: ${type} من ${sender}`);
            return;
        }
        if (!content || content.trim().length === 0) {
            console.log(`⛔ محتوى فارغ من ${sender}`);
            return;
        }

        // ✅ التاك مسموح للجميع - تجاهل أي رسالة فيها mention
        const hasMention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0;
        if (hasMention) {
            console.log(`🔕 تجاهل تاك من: ${sender}`);
            return;
        }

        console.log(`📨 رسالة من ${sender}: "${content}" | type: ${type}`);

        // ══════════════════════════════════════════
        // أوامر المشرف
        // ══════════════════════════════════════════

        // !remove → حذف شخص من القائمة (بالرد على رسالته)
        if (content.trim() === '!remove') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.participant;
            if (quoted) {
                await redis.del(`warned:${quoted}`);
                await sock.sendMessage(from, { text: `✅ تم حذف ${quoted} من القائمة` });
                console.log(`✅ تم حذف ${quoted} من القائمة`);
            } else {
                await sock.sendMessage(from, { text: `⚠️ ارد على رسالة الشخص ثم اكتب !remove` });
            }
            return;
        }

        // !removeall → حذف الكل
        if (content.trim() === '!removeall') {
            await redis.flushAll();
            await sock.sendMessage(from, { text: `✅ تم حذف جميع المحفوظين` });
            console.log(`✅ تم مسح Redis كاملاً`);
            return;
        }

        // !check → التحقق إذا شخص محفوظ (بالرد على رسالته)
        if (content.trim() === '!check') {
            const quoted = msg.message.extendedTextMessage?.contextInfo?.participant;
            if (quoted) {
                const w = await isWarned(quoted);
                await sock.sendMessage(from, { text: w ? `🔴 ${quoted} محفوظ` : `🟢 ${quoted} غير محفوظ` });
            }
            return;
        }

        const warned = await isWarned(sender);
        console.log(`🔍 ${sender} | محفوظ: ${warned}`);

        if (!warned) {
            // شخص جديد → بصمة صوتية + حفظ
            console.log(`🆕 جديد: ${sender} → إرسال البصمة`);
            if (oggPath && fs.existsSync(oggPath)) {
                try {
                    await sock.sendMessage(from, {
                        audio: fs.readFileSync(oggPath),
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,
                    }, { quoted: msg });
                    console.log(`🎙️ تم إرسال البصمة`);
                } catch (err) { console.log(`⚠️ فشل إرسال الصوت: ${err.message}`); }
            }
            await addWarned(sender);

        } else {
            console.log(`🗑️ محفوظ: حذف رسالة ${sender}`);
            await deleteMessage(sock, from, msg.key);
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
