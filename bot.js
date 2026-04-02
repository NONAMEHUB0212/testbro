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

// ========== Webhook ==========
const webhookUrls = process.env.WEBHOOK_URL ? process.env.WEBHOOK_URL.split(',').map(u => u.trim()) : [];
async function sendWebhook(content) {
    if (!webhookUrls.length) return;
    for (const url of webhookUrls) {
        try {
            await axios.post(url, { content }, { timeout: 5000 });
        } catch (err) {
            console.error(`⚠️ ส่ง Webhook ล้มเหลว: ${err.message}`);
        }
    }
}

// ========== MongoDB (พร้อม SSL options) ==========
let mongoClient, db;
let useMongo = false;
if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    let uri = process.env.MONGODB_URI;
    // เพิ่มพารามิเตอร์ SSL ถ้ายังไม่มี
    if (!uri.includes('tlsAllowInvalidCertificates')) {
        uri += (uri.includes('?') ? '&' : '?') + 'tlsAllowInvalidCertificates=true';
    }
    if (!uri.includes('tlsInsecure')) {
        uri += '&tlsInsecure=true';
    }
    mongoClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 30000,
        connectTimeoutMS: 10000
    });
    useMongo = true;
    console.log("📡 กำลังเชื่อมต่อ MongoDB ด้วย URI ที่ปรับแล้ว");
}

// ========== p-limit ==========
let pLimit;
try {
    const pl = require('p-limit');
    pLimit = typeof pl === 'function' ? pl : pl.default;
} catch (e) {
    pLimit = (concurrency) => (fn) => fn();
}
const limit = pLimit(1);

// ========== tw-voucher ==========
let twvoucher;
const twPackage = require('@fortune-inc/tw-voucher');
if (typeof twPackage === 'function') {
    twvoucher = twPackage;
} else if (twPackage.voucher && typeof twPackage.voucher === 'function') {
    twvoucher = twPackage.voucher;
} else {
    twvoucher = twPackage.default || twPackage;
}

// ========== Express & Auth ==========
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

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

function maskPhone(phone) {
    if (!phone) return '';
    let str = phone.toString().trim();
    if (str.length <= 4) return '***';
    return str.slice(0, -4) + '****' + str.slice(-2);
}

// Cache voucher
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

// ========== Session Management ==========
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

// ========== ฟังก์ชันช่วยเหลือ ==========
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

// ========== รีดีมพร้อม Webhook ==========
async function processVoucher(voucher, source, startTime) {
    if (isDuplicate(voucher)) return;
    
    const fullUrl = `https://gift.truemoney.com/campaign/?v=${voucher}`;
    const walletName = CONFIG.walletName || "กระเป๋าหลัก";
    
    const newVoucherMsg = `🎫 เจอ VOUCHER ใหม่\n🔑 ลิ้ง ${fullUrl}\n📱 แหล่งที่มา 💳 "${source}"\n📦 เข้าการเป๋า ${walletName}\n━━━━━━━━━━━━━━━━━━\n⚡ กำลังคว้า...\nby tawan_x2noban`;
    await sendWebhook(newVoucherMsg);
    
    console.log(`📥 ${voucher} (จาก ${source})`);
    const phone = CONFIG.walletNumber.replace(/\s/g, '');
    const voucherUrl = fullUrl;
    const start = startTime || Date.now();
    
    try {
        const result = await twvoucher(phone, voucherUrl);
        const speedMs = Date.now() - start;
        
        if (result && result.amount) {
            const amount = parseFloat(result.amount);
            totalClaimed++;
            totalAmount += amount;
            console.log(`✅ +${amount}฿ (${speedMs}ms)`);
            const successMsg = `🎪 รับซองสำเร็จแล้ว\n🎫 ลิ้ง ${fullUrl}\n⚡ ความเร็ว ${speedMs} ms\n━━━━━━━━━━━━━━━━━━\nby tawan_x2noban`;
            await sendWebhook(successMsg);
        } else {
            totalFailed++;
            const errorMsg = result?.message || 'ไม่ทราบสาเหตุ';
            console.log(`❌ ${errorMsg} (${speedMs}ms)`);
            let statusText = '';
            if (errorMsg.includes('หมดอายุ')) statusText = '🎪 ซองหมดอายุ';
            else if (errorMsg.includes('ไม่พบ')) statusText = '🎪 ไม่พบซอง';
            else if (errorMsg.includes('หมดแล้ว')) statusText = '🎪 ซองหมดแล้ว';
            else statusText = '🎪 ไม่สามารถรับซองได้';
            const failMsg = `${statusText}\n🎫 ลิ้ง ${fullUrl}\n⚡ ความเร็ว ${speedMs} ms\n━━━━━━━━━━━━━━━━━━\nby tawan_x2noban`;
            await sendWebhook(failMsg);
        }
    } catch (err) {
        totalFailed++;
        const speedMs = Date.now() - start;
        console.log(`❌ ${err.message} (${speedMs}ms)`);
        const errorMsg = `🎪 เกิดข้อผิดพลาด\n🎫 ลิ้ง ${fullUrl}\n⚡ ความเร็ว ${speedMs} ms\n━━━━━━━━━━━━━━━━━━\nby tawan_x2noban`;
        await sendWebhook(errorMsg);
    }
}

// ========== หน้าเว็บ (Express) – ตามเดิม ==========
const html = (title, body) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>.../* ใส่ CSS เดิม */</style>
</head><body><div class="box">${body}</div></body></html>`;

// ... (routes เหมือนเดิม ไม่ต้องแก้) ...

app.listen(10000, () => console.log(`🌐 เว็บเซิร์ฟเวอร์รันที่ http://localhost:10000`));
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
            let source = "Unknown";
            if (msg.chat) {
                source = msg.chat.title || msg.chat.username || msg.chat.id?.toString() || "Unknown";
            }
            if (msg.media?.className === "MessageMediaPhoto") {
                try {
                    const downloadPromise = client.downloadMedia(msg.media, { workers: 1 });
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Download timeout')), 8000));
                    const buffer = await Promise.race([downloadPromise, timeoutPromise]);
                    if (buffer && buffer.length > 2000) {
                        const qrData = await decodeQR(buffer);
                        if (qrData) {
                            const vouchers = extractVoucher(qrData);
                            if (vouchers) {
                                const startTime = Date.now();
                                await Promise.all(vouchers.map(v => limit(() => processVoucher(v, source, startTime))));
                            }
                        }
                    }
                } catch (err) {
                    console.error("⚠️ ดาวน์โหลดรูปไม่สำเร็จ (ข้าม):", err.message);
                }
            }
            if (msg.message) {
                const vouchers = extractVoucher(msg.message);
                if (vouchers) {
                    const startTime = Date.now();
                    await Promise.all(vouchers.map(v => limit(() => processVoucher(v, source, startTime))));
                }
            }
        } catch (err) {
            console.error("❌ ข้อผิดพลาดในการประมวลผลข้อความ:", err.message);
        }
    }, new NewMessage({ incoming: true }));
    console.log("✅ บอทพร้อมทำงานแล้ว!\n");
}

// เริ่มต้น MongoDB และ config
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
