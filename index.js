const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

async function startBot() {
    // استخدام مجلد محلي لحفظ الجلسة لضمان عدم ضياعها عند إعادة التشغيل
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }), // تقليل التنبيهات لزيادة الاستقرار
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433"; 
        // تأخير طلب الكود قليلاً لضمان استقرار اتصال السيرفر أولاً
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n\n==============================`);
                console.log(`✅ كود الربط الجديد: ${code}`);
                console.log(`==============================\n\n`);
            } catch (err) { console.log("⚠️ فشل طلب الكود، أعد المحاولة."); }
        }, 8000); 
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (up) => {
        const { connection, lastDisconnect } = up;
        if (connection === 'open') console.log('🦅 صقور العراق: البوت متصل الآن!');
        if (connection === 'close') {
            console.log('🔄 إعادة الاتصال...');
            startBot();
        }
    });

    // كود الحذف والرد الصوتي يبقى كما هو في الأسفل...
}

startBot();
