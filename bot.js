const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const sharp = require("sharp");
const jsQR = require("jsqr");
const fs = require("fs");
const WebSocket = require("ws");
const cloudscraper = require("cloudscraper");
require("dotenv").config();

// ========== Webhook (Discord) ==========
const webhookUrls = process.env.WEBHOOK_URL ? process.env.WEBHOOK_URL.split(',').map(u => u.trim()) : [];
async function sendDiscordEmbed(title, description, color = 5763719, fields = []) {
    if (!webhookUrls.length) return;
    const embed = { title, description, color, timestamp: new Date().toISOString(), fields };
    for (const url of webhookUrls) {
        try {
            await axios.post(url, { embeds: [embed] }, { timeout: 5000 });
        } catch (err) { /* silent */ }
    }
}
async function sendDiscordSimple(content) {
    if (!webhookUrls.length) return;
    for (const url of webhookUrls) {
        try { await axios.post(url, { content }, { timeout: 5000 }); } catch (err) { }
    }
}

// ========== Supabase Session ==========
const { createClient } = require('@supabase/supabase-js');
let supabase = null;
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("📡 ใช้ Supabase เก็บ session");
}

// ========== p-limit ==========
let pLimit;
try { const pl = require('p-limit'); pLimit = typeof pl === 'function' ? pl : pl.default; } catch (e) { pLimit = () => (fn) => fn(); }
const limit = pLimit(1);  // จำกัด concurrency การรีดีม

// ========== Express + WebSocket ==========
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Basic Auth (optional)
if (process.env.ADMIN_PASSWORD) {
    const basicAuth = require('express-basic-auth');
    app.use(basicAuth({ users: { 'admin': process.env.ADMIN_PASSWORD }, challenge: true, unauthorizedResponse: 'Unauthorized' }));
    console.log("🔒 หน้าเว็บต้องใช้รหัสผ่าน admin");
}

let CONFIG = null;
let totalClaimed = 0, totalFailed = 0, totalAmount = 0;
let loginStep = "need-config", otpCode = "", passwordCode = "", client = null;

// Cache voucher
const recentSeen = new Map();
function isDuplicate(voucher) {
    if (recentSeen.has(voucher)) return true;
    recentSeen.set(voucher, Date.now());
    return false;
}
setInterval(() => {
    const now = Date.now();
    for (let [k, t] of recentSeen) if (now - t > 30000) recentSeen.delete(k);
}, 60000);

// ระบบแจกจ่ายเบอร์
let userClaimIndex = 0;
function getClaimPhone(distribution, ownerPhone, userPhones) {
    if (distribution === "owner_only") return ownerPhone;
    if (distribution === "round_robin") {
        const all = [ownerPhone, ...userPhones];
        if (!all.length) return ownerPhone;
        const phone = all[userClaimIndex % all.length];
        userClaimIndex++;
        return phone;
    }
    if (distribution === "users_only") {
        if (!userPhones.length) return ownerPhone;
        const phone = userPhones[userClaimIndex % userPhones.length];
        userClaimIndex++;
        return phone;
    }
    return ownerPhone;
}

// ========== Session Management ==========
async function saveSession(sessionString) {
    if (supabase) {
        try {
            await supabase.from('sessions').upsert({ id: 'telegram_session', session: sessionString, updated_at: new Date() });
            console.log("💾 session เก็บใน Supabase");
        } catch (err) { console.error("Supabase error:", err.message); fs.writeFileSync('session.txt', sessionString); }
    } else { fs.writeFileSync('session.txt', sessionString); }
}
async function loadSession() {
    if (process.env.SESSION_STRING) return process.env.SESSION_STRING;
    if (supabase) {
        try {
            const { data } = await supabase.from('sessions').select('session').eq('id', 'telegram_session').maybeSingle();
            if (data?.session) return data.session;
        } catch (err) { console.error("Supabase load error:", err.message); }
    }
    if (fs.existsSync('session.txt')) return fs.readFileSync('session.txt', 'utf8').trim();
    return null;
}

// ========== ฟังก์ชันรีดีมด้วย cloudscraper ==========
async function claimWithCloudscraper(voucher, phone, retryCount = 0) {
    const url = `https://gift.truemoney.com/campaign/vouchers/${voucher}/redeem`;
    const payload = { mobile: phone.replace(/-/g, ''), voucher_hash: voucher };
    const headers = {
        'Referer': `https://gift.truemoney.com/campaign/?v=${voucher}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
    };
    
    return new Promise((resolve, reject) => {
        cloudscraper.post(url, {
            json: payload,
            headers: headers,
            timeout: 10000
        }, (error, response, body) => {
            if (error) return reject(error);
            resolve(body);
        });
    });
}

async function claimForPhone(voucher, phone, startTime, role) {
    const fullUrl = `https://gift.truemoney.com/campaign/?v=${voucher}`;
    try {
        const result = await claimWithCloudscraper(voucher, phone);
        const ms = Date.now() - startTime;
        if (result.status?.code === 'SUCCESS') {
            const amount = parseFloat(result.data.my_ticket.amount_baht);
            totalClaimed++;
            totalAmount += amount;
            console.log(`✅ ${role}: +${amount}฿ (${ms}ms) เบอร์ ${phone.slice(-4)}`);
            sendDiscordEmbed("🎯 TAWAN SNIPER", 
                `✅ **รีดีมสำเร็จ**\n💰 ${amount} ฿\n⚡ ${ms}ms\n👤 ${role}\n🎫 \`${voucher}\``, 5763719);
            return true;
        } else if (result.status?.code === 'VOUCHER_OUT_OF_STOCK') {
            console.log(`❌ ${role}: ซองหมดแล้ว (${ms}ms)`);
            if (role === "Owner") sendDiscordEmbed("🎪 ซองหมดแล้ว", `🎫 \`${voucher}\`\n⚡ ${ms}ms`, 10197915);
            return true;
        } else if (result.status?.code === 'VOUCHER_EXPIRED') {
            console.log(`❌ ${role}: ซองหมดอายุ (${ms}ms)`);
            if (role === "Owner") sendDiscordEmbed("🎪 ซองหมดอายุ", `🎫 \`${voucher}\`\n⚡ ${ms}ms`, 10197915);
            return true;
        } else if (result.status?.code === 'VOUCHER_NOT_FOUND') {
            console.log(`❌ ${role}: ไม่พบซอง (${ms}ms)`);
            if (role === "Owner") sendDiscordEmbed("🎪 ไม่พบซอง", `🎫 \`${voucher}\`\n⚡ ${ms}ms`, 10197915);
            return true;
        }
        console.log(`❌ ${role}: direct ล้มเหลว (${ms}ms) - ${result.status?.message || ''}`);
        return false;
    } catch (err) {
        console.log(`❌ ${role}: error - ${err.message}`);
        return false;
    }
}

async function processVoucher(voucher, source, startTime) {
    if (isDuplicate(voucher)) return;
    const fullUrl = `https://gift.truemoney.com/campaign/?v=${voucher}`;
    const distribution = CONFIG.distribution || "owner_only";
    const ownerPhone = CONFIG.walletNumber;
    const userPhones = CONFIG.userPhones ? CONFIG.userPhones.split(',').map(p => p.trim()) : [];
    
    // แจ้งเตือนพบ voucher
    sendDiscordSimple(`🎫 เจอ VOUCHER ใหม่\n🔑 ${fullUrl}\n📱 แหล่งที่มา ${source}\n📦 เข้าการเป๋า ${distribution}\n━━━━━━━━━━━━━━━━━━\n⚡ กำลังคว้า...\nby tawan_x2noban`);
    
    if (distribution === "owner_first_then_users") {
        // Owner ก่อน
        const ownerSuccess = await claimForPhone(voucher, ownerPhone, startTime, "Owner");
        // รอ 10ms แล้วให้ users ทุกคน parallel
        await new Promise(r => setTimeout(r, 10));
        const userTasks = userPhones.map(phone => claimForPhone(voucher, phone, startTime, "User"));
        await Promise.all(userTasks);
    } else {
        const targetPhone = getClaimPhone(distribution, ownerPhone, userPhones);
        const success = await claimForPhone(voucher, targetPhone, startTime, "Main");
        if (!success && CONFIG.fallbackApiUrl) {
            // Fallback API
            try {
                const payload = { phone: targetPhone, voucher: voucher };
                const fbRes = await axios.post(CONFIG.fallbackApiUrl, payload, { timeout: 8000 });
                if (fbRes.data?.status === true && fbRes.data?.amount) {
                    const amt = parseFloat(fbRes.data.amount);
                    totalClaimed++; totalAmount += amt;
                    console.log(`✅ Fallback: +${amt}฿ เบอร์ ${targetPhone.slice(-4)}`);
                    sendDiscordEmbed("🎯 TAWAN SNIPER", `✅ **Fallback สำเร็จ**\n💰 ${amt} ฿\n🎫 \`${voucher}\``, 5763719);
                } else {
                    totalFailed++;
                    sendDiscordEmbed("⚠️ คว้าล้มเหลว", `🎫 \`${voucher}\`\n❌ Direct + Fallback ล้มเหลว`, 15158332);
                }
            } catch (err) { totalFailed++; }
        } else if (!success) totalFailed++;
    }
    // อัปเดตสถิติ (Dashboard)
    updateDashboardStats();
}

// ========== ขยายลิงก์ย่อ ==========
async function expandShortUrl(shortUrl) {
    try {
        const resp = await axios.head(shortUrl, { maxRedirects: 5, timeout: 5000 });
        return resp.request.res.responseUrl || shortUrl;
    } catch { return shortUrl; }
}

// ========== WebSocket Dashboard ==========
const wss = new WebSocket.Server({ port: 10001 });
let dashboardStats = { claimed: 0, failed: 0, total: 0, queue: 0, status: "พร้อม" };
function updateDashboardStats() {
    dashboardStats = { claimed: totalClaimed, failed: totalFailed, total: totalAmount, queue: 0, status: "ทำงาน" };
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(dashboardStats)); });
}

// ========== Express Routes (หน้าเว็บ) ==========
const htmlTemplate = (title, body) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.box{background:#fff;border-radius:15px;padding:40px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
h1{color:#667eea;margin-bottom:20px;font-size:28px;text-align:center}
input,select,button{width:100%;padding:15px;margin:10px 0;border-radius:8px;font-size:16px;border:2px solid #e5e7eb}
button{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;border:none;cursor:pointer;font-weight:600}
.info{background:#f0f9ff;padding:15px;border-radius:8px;margin:10px 0;font-size:14px}
</style>
<script>
let ws;
function connectWS() {
    ws = new WebSocket('ws://' + location.hostname + ':10001');
    ws.onmessage = (e) => { const d = JSON.parse(e.data); document.getElementById('claimed').innerText = d.claimed; document.getElementById('failed').innerText = d.failed; document.getElementById('total').innerText = d.total.toFixed(2); };
}
window.onload = connectWS;
</script>
</head><body><div class="box">${body}</div></body></html>`;

app.get('/', (req, res) => {
    if (!CONFIG) {
        res.send(htmlTemplate("ตั้งค่าบอท", `
            <h1>🚀 TrueMoney Auto Claim</h1>
            <form action="/save-config" method="POST">
                <input type="text" name="apiId" placeholder="API ID" required>
                <input type="text" name="apiHash" placeholder="API Hash" required>
                <input type="text" name="phoneNumber" placeholder="+668xxxxxxxx" required>
                <input type="text" name="walletNumber" placeholder="เบอร์ TrueMoney หลัก" required>
                <input type="text" name="userPhones" placeholder="เบอร์รอง,คั่นด้วยคอมมา (ไม่บังคับ)">
                <select name="distribution">
                    <option value="owner_only">รับเฉพาะหลัก</option>
                    <option value="round_robin">สลับหลัก+รอง</option>
                    <option value="users_only">รับเฉพาะรอง</option>
                    <option value="owner_first_then_users">หลักก่อนแล้วรอง parallel</option>
                </select>
                <input type="text" name="fallbackApiUrl" placeholder="Fallback API URL (ไม่บังคับ)">
                <label><input type="checkbox" name="useQR"> เปิดสแกน QR</label>
                <label><input type="checkbox" name="expandShortUrls" checked> ขยายลิงก์ย่อ</label>
                <button type="submit">บันทึกและเริ่ม</button>
            </form>
        `));
    } else if (loginStep === "logged-in") {
        res.send(htmlTemplate("Dashboard", `
            <h1>🚀 TrueMoney Bot</h1>
            <div>รับสำเร็จ: <span id="claimed">${totalClaimed}</span></div>
            <div>ล้มเหลว: <span id="failed">${totalFailed}</span></div>
            <div>ยอดรวม: <span id="total">${totalAmount.toFixed(2)}</span> ฿</div>
            <button onclick="location.href='/reset'">ตั้งค่าใหม่</button>
        `));
    } else if (loginStep === "need-send-otp") {
        res.send(htmlTemplate("Login", `<form action="/send-otp" method="POST"><button>ส่ง OTP</button></form>`));
    } else if (loginStep === "need-otp") {
        res.send(htmlTemplate("OTP", `<form action="/verify-otp" method="POST"><input name="otp" placeholder="12345"><button>ยืนยัน</button></form>`));
    } else if (loginStep === "need-password") {
        res.send(htmlTemplate("2FA", `<form action="/verify-2fa" method="POST"><input type="password" name="password" placeholder="รหัส 2FA"><button>ยืนยัน</button></form><form action="/skip-2fa" method="POST"><button>ข้าม</button></form>`));
    } else {
        res.send(htmlTemplate("Loading", "<div>กำลังเริ่มต้น...</div>"));
    }
});

app.post('/save-config', (req, res) => {
    CONFIG = {
        apiId: parseInt(req.body.apiId),
        apiHash: req.body.apiHash,
        phoneNumber: req.body.phoneNumber,
        walletNumber: req.body.walletNumber,
        userPhones: req.body.userPhones || "",
        distribution: req.body.distribution,
        fallbackApiUrl: req.body.fallbackApiUrl || null,
        useQR: req.body.useQR === "on",
        expandShortUrls: req.body.expandShortUrls === "on",
    };
    const envContent = `API_ID=${CONFIG.apiId}\nAPI_HASH=${CONFIG.apiHash}\nPHONE_NUMBER=${CONFIG.phoneNumber}\nWALLET_NUMBER=${CONFIG.walletNumber}\nUSER_PHONES=${CONFIG.userPhones}\nDISTRIBUTION=${CONFIG.distribution}\nFALLBACK_API_URL=${CONFIG.fallbackApiUrl||''}\nUSE_QR=${CONFIG.useQR}\nEXPAND_SHORT_URLS=${CONFIG.expandShortUrls}`;
    fs.writeFileSync('.env', envContent);
    res.send(htmlTemplate("บันทึกสำเร็จ", "<div>กำลังเริ่มบอท...</div><script>setTimeout(()=>location.href='/',2000)</script>"));
    setTimeout(() => startBot(), 3000);
});

app.get('/reset', (req, res) => { CONFIG = null; if(fs.existsSync('.env')) fs.unlinkSync('.env'); if(fs.existsSync('session.txt')) fs.unlinkSync('session.txt'); res.redirect('/'); });
app.post('/send-otp', (req, res) => { loginStep = "need-otp"; res.redirect('/'); });
app.post('/verify-otp', (req, res) => { otpCode = req.body.otp; res.redirect('/'); });
app.post('/verify-2fa', (req, res) => { passwordCode = req.body.password; res.redirect('/'); });
app.post('/skip-2fa', (req, res) => { passwordCode = ""; res.redirect('/'); });

app.listen(10000, () => console.log("🌐 เว็บ: http://localhost:10000"));
setInterval(() => { axios.get(process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000').catch(()=>{}); }, 30*60*1000);

// ========== ฟังก์ชันหลัก Telegram ==========
async function startBot() {
    if (!CONFIG) return;
    let sessionString = await loadSession();
    const session = new StringSession(sessionString || '');
    client = new TelegramClient(session, CONFIG.apiId, CONFIG.apiHash, {
        connectionRetries: 10, useWSS: true, autoReconnect: true, retryDelay: 5000
    });
    console.log("🚀 กำลังเริ่มบอท...");
    try {
        if (sessionString) {
            await client.start({ botAuthToken: false, onError: e => console.error(e.message) });
            loginStep = "logged-in";
            console.log("✅ เชื่อมต่อสำเร็จ");
        } else {
            loginStep = "need-send-otp";
            await client.start({
                phoneNumber: async () => { while (loginStep === "need-send-otp") await new Promise(r => setTimeout(r, 100)); return CONFIG.phoneNumber; },
                password: async () => { loginStep = "need-password"; while (loginStep === "need-password" && passwordCode === "") await new Promise(r => setTimeout(r, 100)); return passwordCode || undefined; },
                phoneCode: async () => { while (!otpCode) await new Promise(r => setTimeout(r, 100)); const code = otpCode; otpCode = ""; return code; },
                onError: e => console.error(e.message),
            });
            const newSession = client.session.save();
            await saveSession(newSession);
            loginStep = "logged-in";
            console.log("✅ เข้าสู่ระบบสำเร็จ");
        }
    } catch (err) { console.error("❌ Login ล้มเหลว:", err.message); return; }
    
    console.log("👂 กำลังฟังข้อความ...");
    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg) return;
            let source = msg.chat?.title || msg.chat?.username || "Unknown";
            // ดึง voucher จากข้อความ
            let vouchers = [];
            if (msg.message) {
                const matches = msg.message.match(/v=([a-zA-Z0-9]+)/g);
                if (matches) vouchers.push(...matches.map(m => m.slice(2)));
            }
            // ถ้ามีรูปและเปิด QR scan
            if (msg.media?.className === "MessageMediaPhoto" && CONFIG.useQR) {
                try {
                    const buffer = await client.downloadMedia(msg.media, { workers: 1 });
                    if (buffer && buffer.length > 2000) {
                        const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
                        const qr = jsQR(new Uint8ClampedArray(data), info.width, info.height);
                        if (qr && qr.data) {
                            const qrMatches = qr.data.match(/v=([a-zA-Z0-9]+)/);
                            if (qrMatches) vouchers.push(qrMatches[1]);
                        }
                    }
                } catch (err) { console.error("QR decode error:", err.message); }
            }
            // ขยายลิงก์ย่อถ้าเปิดใช้งาน
            if (CONFIG.expandShortUrls && msg.message) {
                const shortUrlPattern = /https?:\/\/(bit\.ly|tinyurl\.com|goo\.gl|tmn\.app)\/[\w\-]+/i;
                const shortMatch = msg.message.match(shortUrlPattern);
                if (shortMatch) {
                    const expanded = await expandShortUrl(shortMatch[0]);
                    const expandedVoucher = expanded.match(/v=([a-zA-Z0-9]+)/);
                    if (expandedVoucher) vouchers.push(expandedVoucher[1]);
                }
            }
            // รีดีม voucher ที่พบ
            for (const v of [...new Set(vouchers)]) {
                const start = Date.now();
                await limit(() => processVoucher(v, source, start));
            }
        } catch (err) { console.error("Handler error:", err.message); }
    }, new NewMessage({ incoming: true }));
    console.log("✅ บอทพร้อมทำงาน");
}

// เริ่มต้น
if (fs.existsSync('.env')) {
    require('dotenv').config();
    if (process.env.API_ID && process.env.API_HASH) {
        CONFIG = {
            apiId: parseInt(process.env.API_ID),
            apiHash: process.env.API_HASH,
            phoneNumber: process.env.PHONE_NUMBER,
            walletNumber: process.env.WALLET_NUMBER,
            userPhones: process.env.USER_PHONES || "",
            distribution: process.env.DISTRIBUTION || "owner_only",
            fallbackApiUrl: process.env.FALLBACK_API_URL || null,
            useQR: process.env.USE_QR === "true",
            expandShortUrls: process.env.EXPAND_SHORT_URLS !== "false",
        };
        startBot();
    }
}
