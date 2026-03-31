const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const sharp = require("sharp");
const jsQR = require("jsqr");
const fs = require("fs");
require("dotenv").config();

// ========== MongoDB (ถ้ามี URI) ==========
let mongoClient, db;
let useMongo = false;
if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    useMongo = true;
}

// ========== รองรับ p-limit (CommonJS/ESM) ==========
let pLimit;
try {
    const pl = require('p-limit');
    pLimit = typeof pl === 'function' ? pl : pl.default;
} catch (e) {
    pLimit = (concurrency) => (fn) => fn();
}
const limit = pLimit(1);

// ========== ตั้งค่า tw-voucher ==========
let twvoucher;
const twPackage = require('@fortune-inc/tw-voucher');
if (typeof twPackage === 'function') {
    twvoucher = twPackage;
} else if (twPackage.voucher && typeof twPackage.voucher === 'function') {
    twvoucher = twPackage.voucher;
} else {
    twvoucher = twPackage.default || twPackage;
}

// ========== ตัวแปรส่วนกลาง ==========
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// HTTP Basic Auth (optional) – ใช้ environment variable ADMIN_PASSWORD
if (process.env.ADMIN_PASSWORD) {
    const basicAuth = require('express-basic-auth');
    app.use(basicAuth({
        users: { 'admin': process.env.ADMIN_PASSWORD },
        challenge: true,
        unauthorizedResponse: 'Unauthorized'
    }));
    console.log("🔒 หน้าเว็บต้องใช้รหัสผ่าน admin");
}

let CONFIG = null;
let totalClaimed = 0;
let totalFailed = 0;
let totalAmount = 0;
let loginStep = "need-config";
let otpCode = "";
let passwordCode = "";
let client = null;

// ปกปิดเบอร์
function maskPhone(phone) {
    if (!phone) return '';
    let str = phone.toString().trim();
    if (str.length <= 4) return '***';
    return str.slice(0, -4) + '****' + str.slice(-2);
}

// Cache สำหรับ voucher
const recentSeen = new Map();
function isDuplicate(voucher) {
    if (recentSeen.has(voucher)) return true;
    recentSeen.set(voucher, Date.now());
    return false;
}
setInterval(() => {
    const now = Date.now();
    for (let [k, t] of recentSeen) {
        if (now - t > 30000) recentSeen.delete(k);
    }
}, 60000);

// ========== ฟังก์ชันจัดการ session ==========
async function saveSession(sessionString) {
    if (useMongo) {
        if (!db) db = mongoClient.db('truemoney');
        await db.collection('sessions').updateOne(
            { _id: 'telegram_session' },
            { $set: { session: sessionString, updatedAt: new Date() } },
            { upsert: true }
        );
        console.log("💾 บันทึก session ลง MongoDB เรียบร้อย");
    } else {
        fs.writeFileSync('session.txt', sessionString, 'utf8');
        console.log("💾 บันทึก session ลงไฟล์ session.txt");
    }
}

async function loadSession() {
    // ลำดับ: env SESSION_STRING > MongoDB > ไฟล์
    if (process.env.SESSION_STRING) {
        console.log("📂 ใช้ session จาก environment variable");
        return process.env.SESSION_STRING;
    }
    if (useMongo) {
        try {
            if (!db) db = mongoClient.db('truemoney');
            const doc = await db.collection('sessions').findOne({ _id: 'telegram_session' });
            if (doc && doc.session) {
                console.log("📂 โหลด session จาก MongoDB สำเร็จ");
                return doc.session;
            }
        } catch (err) {
            console.error("⚠️ โหลด session จาก MongoDB ล้มเหลว:", err.message);
        }
    }
    if (fs.existsSync('session.txt')) {
        console.log("📂 โหลด session จากไฟล์ session.txt");
        return fs.readFileSync('session.txt', 'utf8').trim();
    }
    return null;
}

// ========== ฟังก์ชันช่วยเหลือ (ภาษาไทย, QR, voucher) ==========
function hasThai(text) {
    return /[\u0E00-\u0E7F]/.test(text);
}

const thaiMap = {
    "เก้าสิบเก้า":"99","เก้าสิบแปด":"98","เก้าสิบเจ็ด":"97","เก้าสิบหก":"96","เก้าสิบห้า":"95","เก้าสิบสี่":"94","เก้าสิบสาม":"93","เก้าสิบสอง":"92","เก้าสิบเอ็ด":"91","เก้าสิบ":"90",
    "แปดสิบเก้า":"89","แปดสิบแปด":"88","แปดสิบเจ็ด":"87","แปดสิบหก":"86","แปดสิบห้า":"85","แปดสิบสี่":"84","แปดสิบสาม":"83","แปดสิบสอง":"82","แปดสิบเอ็ด":"81","แปดสิบ":"80",
    "เจ็ดสิบเก้า":"79","เจ็ดสิบแปด":"78","เจ็ดสิบเจ็ด":"77","เจ็ดสิบหก":"76","เจ็ดสิบห้า":"75","เจ็ดสิบสี่":"74","เจ็ดสิบสาม":"73","เจ็ดสิบสอง":"72","เจ็ดสิบเอ็ด":"71","เจ็ดสิบ":"70",
    "หกสิบเก้า":"69","หกสิบแปด":"68","หกสิบเจ็ด":"67","หกสิบหก":"66","หกสิบห้า":"65","หกสิบสี่":"64","หกสิบสาม":"63","หกสิบสอง":"62","หกสิบเอ็ด":"61","หกสิบ":"60",
    "ห้าสิบเก้า":"59","ห้าสิบแปด":"58","ห้าสิบเจ็ด":"57","ห้าสิบหก":"56","ห้าสิบห้า":"55","ห้าสิบสี่":"54","ห้าสิบสาม":"53","ห้าสิบสอง":"52","ห้าสิบเอ็ด":"51","ห้าสิบ":"50",
    "สี่สิบเก้า":"49","สี่สิบแปด":"48","สี่สิบเจ็ด":"47","สี่สิบหก":"46","สี่สิบห้า":"45","สี่สิบสี่":"44","สี่สิบสาม":"43","สี่สิบสอง":"42","สี่สิบเอ็ด":"41","สี่สิบ":"40",
    "สามสิบเก้า":"39","สามสิบแปด":"38","สามสิบเจ็ด":"37","สามสิบหก":"36","สามสิบห้า":"35","สามสิบสี่":"34","สามสิบสาม":"33","สามสิบสอง":"32","สามสิบเอ็ด":"31","สามสิบ":"30",
    "ยี่สิบเก้า":"29","ยี่สิบแปด":"28","ยี่สิบเจ็ด":"27","ยี่สิบหก":"26","ยี่สิบห้า":"25","ยี่สิบสี่":"24","ยี่สิบสาม":"23","ยี่สิบสอง":"22","ยี่สิบเอ็ด":"21","ยี่สิบ":"20",
    "สิบเก้า":"19","สิบแปด":"18","สิบเจ็ด":"17","สิบหก":"16","สิบห้า":"15","สิบสี่":"14","สิบสาม":"13","สิบสอง":"12","สิบเอ็ด":"11","สิบ":"10",
    "ศูนย์":"0","หนึ่ง":"1","สอง":"2","สาม":"3","สี่":"4","ห้า":"5","หก":"6","เจ็ด":"7","แปด":"8","เก้า":"9","เอ็ด":"1","ยี่":"2"
};
const thaiKeys = Object.keys(thaiMap).sort((a,b)=>b.length-a.length);

function decodeThai(text) {
    if (!text || !hasThai(text)) return text;
    let decoded = text;
    for (const key of thaiKeys) {
        decoded = decoded.replace(new RegExp(key, 'gi'), thaiMap[key]);
    }
    return decoded.replace(/[^a-zA-Z0-9]/g, '');
}

function isLikelyVoucher(s) {
    return s && s.length >= 20 && s.length <= 64 && /^[a-zA-Z0-9]+$/.test(s);
}

async function decodeQR(buffer) {
    try {
        if (buffer.length < 2000) return null;
        const { data, info } = await sharp(buffer)
            .raw()
            .toBuffer({ resolveWithObject: true });
        const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
        return code?.data || null;
    } catch {
        return null;
    }
}

function extractVoucher(text) {
    if (!text) return null;
    const results = [];
    const urlRegex = /https?:\/\/gift\.truemoney\.com\/campaign\/?\??.*?v=([a-zA-Z0-9]+)/gi;
    const matches = [...text.matchAll(urlRegex)];
    for (const match of matches) {
        let voucher = match[1].trim();
        if (hasThai(voucher)) voucher = decodeThai(voucher);
        voucher = voucher.replace(/\s/g, '');
        if (isLikelyVoucher(voucher)) results.push(voucher);
    }
    return results.length ? results : null;
}

// ========== ฟังก์ชันรีดีม ==========
async function processVoucher(voucher) {
    if (isDuplicate(voucher)) return;
    console.log(`📥 พบ voucher: ${voucher}`);
    const phone = CONFIG.walletNumber.replace(/\s/g, '');
    const voucherUrl = `https://gift.truemoney.com/campaign/?v=${voucher}`;
    try {
        const result = await twvoucher(phone, voucherUrl);
        if (result && result.amount) {
            const amount = parseFloat(result.amount);
            totalClaimed++;
            totalAmount += amount;
            console.log(`✅ รับสำเร็จ +${amount} บาท`);
        } else {
            totalFailed++;
            console.log(`❌ รับไม่สำเร็จ: ${result?.message || 'ไม่ทราบสาเหตุ'}`);
        }
    } catch (err) {
        totalFailed++;
        console.log(`❌ เกิดข้อผิดพลาด: ${err.message}`);
    }
}

// ========== หน้าเว็บ (Express) ==========
const html = (title, body) => `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.box{background:#fff;border-radius:15px;padding:40px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
h1{color:#667eea;margin-bottom:20px;font-size:28px;text-align:center}
h2{color:#374151;font-size:18px;margin:20px 0 10px;border-bottom:2px solid #e5e7eb;padding-bottom:10px}
input,button,textarea{width:100%;padding:15px;margin:10px 0;border-radius:8px;font-size:16px;border:2px solid #e5e7eb;transition:all 0.3s}
input:focus,textarea:focus{outline:none;border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,0.1)}
button{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;border:none;cursor:pointer;font-weight:600}
button:hover{transform:translateY(-2px);box-shadow:0 10px 20px rgba(102,126,234,0.3)}
.info{background:#f0f9ff;padding:15px;border-radius:8px;margin:10px 0;font-size:14px;border-left:4px solid #3b82f6;color:#1e40af}
.warning{background:#fef3c7;border-left-color:#f59e0b;color:#92400e}
.success{background:#d1fae5;border-left-color:#10b981;color:#065f46}
.stat{display:grid;grid-template-columns:1fr 1fr 1fr;gap:15px;margin:20px 0}
.stat div{background:#f9fafb;padding:20px;border-radius:10px;text-align:center;border:2px solid #e5e7eb}
.stat div span{display:block;font-size:32px;font-weight:bold;color:#667eea;margin-top:8px}
.label{font-weight:600;color:#374151;margin:15px 0 5px;display:block}
.note{font-size:12px;color:#6b7280;margin-top:5px}
.code{background:#1f2937;color:#10b981;padding:8px 12px;border-radius:5px;font-family:monospace;font-size:14px;display:inline-block;margin:5px 0}
.step{background:#f3f4f6;padding:15px;border-radius:8px;margin:15px 0;border-left:4px solid #667eea}
.step-num{background:#667eea;color:#fff;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:bold;margin-right:10px}
a{color:#667eea;text-decoration:none;font-weight:600}
a:hover{text-decoration:underline}
</style>
</head><body><div class="box">${body}</div></body></html>`;

app.get('/', (req, res) => {
    if (!CONFIG) {
        res.send(html("ตั้งค่าบอท", `
            <h1>🚀 TrueMoney Auto Claim</h1>
            <div class="warning">⚙️ กรุณาตั้งค่าบอทก่อนใช้งาน</div>
            <h2>📋 ขั้นตอนการตั้งค่า</h2>
            <div class="step"><span class="step-num">1</span><strong>สมัคร Telegram API</strong><div class="note">ไปที่ <a href="https://my.telegram.org/apps" target="_blank">https://my.telegram.org/apps</a></div><div class="note">1. Login ด้วยเบอร์ Telegram ของคุณ</div><div class="note">2. กรอกข้อมูล:</div><div class="note" style="margin-left:20px">• App title: <span class="code">TrueMoney Bot</span></div><div class="note" style="margin-left:20px">• Short name: <span class="code">tmbot</span></div><div class="note" style="margin-left:20px">• Platform: <span class="code">Desktop</span></div><div class="note">3. กด Create application</div><div class="note">4. คัดลอก <strong>api_id</strong> และ <strong>api_hash</strong></div></div>
            <div class="step"><span class="step-num">2</span><strong>กรอกข้อมูลด้านล่าง</strong></div>
            <form action="/save-config" method="POST">
                <label class="label">🔑 API ID</label><input type="text" name="apiId" placeholder="12345678" required><div class="note">ตัวเลขที่ได้จาก my.telegram.org</div>
                <label class="label">🔐 API Hash</label><input type="text" name="apiHash" placeholder="abc123def456..." required><div class="note">รหัสยาวๆ ที่ได้จาก my.telegram.org</div>
                <label class="label">📱 เบอร์ Telegram</label><input type="text" name="phoneNumber" placeholder="+66812345678" required><div class="note">ต้องขึ้นต้นด้วย +66 (ไม่ใช่ 0)</div>
                <label class="label">💰 เบอร์กระเป๋า TrueMoney</label><input type="text" name="walletNumber" placeholder="0812345678" required><div class="note">เบอร์ที่จะรับเงิน (เริ่มต้นด้วย 0)</div>
                <label class="label">📝 ชื่อกระเป๋า (ไม่บังคับ)</label><input type="text" name="walletName" placeholder="กระเป๋าหลัก">
                <button type="submit">✅ บันทึกและเริ่มใช้งาน</button>
            </form>
            <div class="info" style="margin-top:20px">💡 <strong>หมายเหตุ:</strong> ข้อมูลจะถูกเก็บไว้ใน Environment Variables</div>
        `));
    } else if (loginStep === "logged-in") {
        res.send(html("Dashboard", `
            <h1>🚀 TrueMoney Bot</h1>
            <div class="success">✅ บอทกำลังทำงาน</div>
            <div class="stat"><div>รับสำเร็จ<span>${totalClaimed}</span></div><div>ล้มเหลว<span>${totalFailed}</span></div><div>ยอดรวม<span>${totalAmount}฿</span></div></div>
            <div class="info">📱 เบอร์: ${maskPhone(CONFIG.phoneNumber)}</div>
            <div class="info">💰 กระเป๋า: ${CONFIG.walletName} (${maskPhone(CONFIG.walletNumber)})</div>
            <button onclick="if(confirm('ต้องการตั้งค่าใหม่?')){location.href='/reset'}" style="background:#ef4444;margin-top:20px">🔄 ตั้งค่าใหม่</button>
        `));
    } else if (loginStep === "need-send-otp") {
        res.send(html("Login", `<h1>📱 Login Telegram</h1><div class="warning">📮 กดปุ่มด้านล่างเพื่อส่ง OTP</div><div class="info">เบอร์: ${maskPhone(CONFIG.phoneNumber)}</div><form action="/send-otp" method="POST"><button type="submit">📨 ส่ง OTP</button></form>`));
    } else if (loginStep === "need-otp") {
        res.send(html("OTP", `<h1>🔑 ใส่รหัส OTP</h1><div class="warning">📱 ตรวจสอบรหัส OTP ใน Telegram</div><form action="/verify-otp" method="POST"><input type="text" name="otp" placeholder="12345" maxlength="5" required autofocus><button type="submit">✅ ยืนยัน</button></form>`));
    } else if (loginStep === "need-password") {
        res.send(html("2FA", `<h1>🔒 Two-Factor Authentication</h1><div class="warning">🔐 ถ้าไม่มี 2FA ให้กด "ข้าม"</div><form action="/verify-2fa" method="POST"><input type="password" name="password" placeholder="รหัส 2FA" autofocus><button type="submit">✅ ยืนยัน</button></form><form action="/skip-2fa" method="POST"><button type="submit" style="background:#6b7280">⏭️ ข้าม</button></form>`));
    } else {
        res.send(html("Loading", `<h1>🚀 กำลังเริ่มต้น...</h1><div class="info">⏳ กรุณารอสักครู่...</div><script>setTimeout(()=>location.reload(),3000)</script>`));
    }
});

app.post('/save-config', async (req, res) => {
    CONFIG = {
        apiId: parseInt(req.body.apiId),
        apiHash: req.body.apiHash,
        phoneNumber: req.body.phoneNumber,
        walletNumber: req.body.walletNumber,
        walletName: req.body.walletName || "กระเป๋าหลัก"
    };
    const envContent = `API_ID=${CONFIG.apiId}\nAPI_HASH=${CONFIG.apiHash}\nPHONE_NUMBER=${CONFIG.phoneNumber}\nWALLET_NUMBER=${CONFIG.walletNumber}\nWALLET_NAME=${CONFIG.walletName}`;
    fs.writeFileSync('.env', envContent);
    res.send(html("บันทึกสำเร็จ", `<h1>✅ บันทึกการตั้งค่าสำเร็จ</h1><div class="success">กำลังเริ่มต้นบอท...</div><div class="info">📱 เบอร์: ${maskPhone(CONFIG.phoneNumber)}<br>💰 กระเป๋า: ${CONFIG.walletName} (${maskPhone(CONFIG.walletNumber)})</div><script>setTimeout(()=>location.href='/',2000)</script>`));
    setTimeout(() => startBot(), 3000);
});

app.get('/reset', (req, res) => {
    CONFIG = null;
    if (fs.existsSync('.env')) fs.unlinkSync('.env');
    if (fs.existsSync('session.txt')) fs.unlinkSync('session.txt');
    res.redirect('/');
});

app.post('/send-otp', (req, res) => {
    loginStep = "need-otp";
    res.send(html("Sending", `<h1>📤 กำลังส่ง OTP</h1><div class="info">⏳ กรุณารอสักครู่...</div><script>setTimeout(()=>location.href='/',2000)</script>`));
});
app.post('/verify-otp', (req, res) => {
    otpCode = req.body.otp;
    res.send(html("Processing", `<h1>✅ กำลังตรวจสอบ OTP</h1><div class="info">⏳ กรุณารอสักครู่...</div><script>setTimeout(()=>location.href='/',3000)</script>`));
});
app.post('/verify-2fa', (req, res) => {
    passwordCode = req.body.password;
    res.send(html("Processing", `<h1>✅ กำลังตรวจสอบ 2FA</h1><div class="info">⏳ กรุณารอสักครู่...</div><script>setTimeout(()=>location.href='/',3000)</script>`));
});
app.post('/skip-2fa', (req, res) => {
    passwordCode = "";
    res.send(html("Processing", `<h1>✅ กำลังเข้าสู่ระบบ</h1><div class="info">⏳ กรุณารอสักครู่...</div><script>setTimeout(()=>location.href='/',3000)</script>`));
});

app.listen(10000, () => console.log(`🌐 เว็บเซิร์ฟเวอร์รันที่ http://localhost:10000`));

// Keep-alive ping ทุก 30 นาที
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:10000`;
    axios.get(url).catch(() => {});
}, 30 * 60 * 1000);

// ========== ฟังก์ชันหลัก ==========
async function startBot() {
    if (!CONFIG) return;
    let sessionString = await loadSession();
    const session = new StringSession(sessionString || '');
    client = new TelegramClient(session, CONFIG.apiId, CONFIG.apiHash, {
        connectionRetries: 10,
        useWSS: true,
        autoReconnect: true,
        retryDelay: 5000
    });
    console.log("🚀 กำลังเริ่มบอท...\n");
    try {
        if (sessionString) {
            console.log("🔐 กำลังเชื่อมต่อด้วย session ที่บันทึกไว้...");
            await client.start({ botAuthToken: false, onError: e => console.error(e.message) });
            loginStep = "logged-in";
            console.log("✅ เชื่อมต่อสำเร็จ!\n");
        } else {
            console.log("🔐 ยังไม่มี session กรุณา login ผ่านเว็บ...\n");
            loginStep = "need-send-otp";
            await client.start({
                phoneNumber: async () => {
                    while (loginStep === "need-send-otp") await new Promise(r => setTimeout(r, 100));
                    return CONFIG.phoneNumber;
                },
                password: async () => {
                    loginStep = "need-password";
                    while (loginStep === "need-password" && passwordCode === "") await new Promise(r => setTimeout(r, 100));
                    return passwordCode || undefined;
                },
                phoneCode: async () => {
                    while (!otpCode) await new Promise(r => setTimeout(r, 100));
                    const code = otpCode;
                    otpCode = "";
                    return code;
                },
                onError: e => console.error(e.message),
            });
            const newSession = client.session.save();
            await saveSession(newSession);
            loginStep = "logged-in";
            console.log("\n✅ เข้าสู่ระบบสำเร็จ!\n");
        }
    } catch (err) {
        console.error("❌ Login ล้มเหลว:", err.message);
        return;
    }
    console.log("👂 กำลังฟังข้อความใน Telegram...\n");
    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg) return;
            // รูปภาพ – ป้องกัน timeout และข้ามไฟล์เล็ก
            if (msg.media?.className === "MessageMediaPhoto") {
                try {
                    const buffer = await client.downloadMedia(msg.media, { workers: 1, timeout: 10000 });
                    if (buffer && buffer.length > 2000) {
                        const qrData = await decodeQR(buffer);
                        if (qrData) {
                            const vouchers = extractVoucher(qrData);
                            if (vouchers) await Promise.all(vouchers.map(v => limit(() => processVoucher(v))));
                        }
                    }
                } catch (err) {
                    console.error("⚠️ ดาวน์โหลดรูปไม่สำเร็จ (ข้าม):", err.message);
                }
            }
            // ข้อความ
            if (msg.message) {
                const vouchers = extractVoucher(msg.message);
                if (vouchers) await Promise.all(vouchers.map(v => limit(() => processVoucher(v))));
            }
        } catch (err) {
            console.error("❌ ข้อผิดพลาดในการประมวลผลข้อความ:", err.message);
        }
    }, new NewMessage({ incoming: true }));
    console.log("✅ บอทพร้อมทำงานแล้ว!\n");
}

// เริ่มต้น MongoDB (ถ้ามี) และโหลด config
(async () => {
    if (useMongo) {
        try {
            await mongoClient.connect();
            db = mongoClient.db('truemoney');
            console.log("✅ เชื่อมต่อ MongoDB สำเร็จ");
        } catch (err) {
            console.error("❌ เชื่อมต่อ MongoDB ล้มเหลว:", err.message);
            useMongo = false;
        }
    }
    if (fs.existsSync('.env')) {
        require('dotenv').config();
        if (process.env.API_ID && process.env.API_HASH) {
            CONFIG = {
                apiId: parseInt(process.env.API_ID),
                apiHash: process.env.API_HASH,
                phoneNumber: process.env.PHONE_NUMBER,
                walletNumber: process.env.WALLET_NUMBER,
                walletName: process.env.WALLET_NAME || "กระเป๋าหลัก"
            };
            startBot();
        }
    }
})();
