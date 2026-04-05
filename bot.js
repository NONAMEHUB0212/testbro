const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const sharp = require("sharp");
const jsQR = require("jsqr");
const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");
const cloudscraper = require("cloudscraper");
require("dotenv").config();

// ========== แก้ไขปัญหา p-limit (ใช้เวอร์ชัน 4.x) ==========
// รองรับ p-limit ทั้ง CommonJS และ ESM
let pLimit;
try {
    const pl = require('p-limit');
    pLimit = typeof pl === 'function' ? pl : pl.default;
} catch (e) {
    // Fallback ถ้าไม่มี p-limit
    pLimit = (concurrency) => (fn) => fn();
}
const limit = pLimit(1);
const userLimit = pLimit(3);

// ========== Discord ==========
const webhookUrls = process.env.WEBHOOK_URL ? process.env.WEBHOOK_URL.split(',').map(u => u.trim()) : [];

async function sendDiscordEmbed(title, description, color = 0x667eea) {
    if (!webhookUrls.length) return;
    const embed = { title, description, color, timestamp: new Date().toISOString() };
    for (const url of webhookUrls) {
        try { await axios.post(url, { embeds: [embed] }, { timeout: 5000 }); } catch {}
    }
}
async function sendDiscordSimple(content) {
    if (!webhookUrls.length) return;
    for (const url of webhookUrls) {
        try { await axios.post(url, { content }, { timeout: 5000 }); } catch {}
    }
}

// ========== Supabase ==========
const { createClient } = require('@supabase/supabase-js');
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log("📡 ใช้ Supabase เก็บ session");
}

// ========== Stats & Racing ==========
let totalClaimed = 0, totalFailed = 0, totalAmount = 0;
let totalLatencySum = 0, latencyCount = 0, bestLatency = Infinity, worstLatency = 0;
let yesterdayClaimed = 0, yesterdayAvgLatency = 0;
let hourlyLatencies = []; // { hour, avg }
let roundRobinIndex = 0;

let CONFIG = null;
let loginStep = "need-config", otpCode = "", passwordCode = "", client = null;

// Cache
const recentSeen = new Map();
const expiredCache = new Set();

function isDuplicate(voucher) {
    if (recentSeen.has(voucher)) return true;
    recentSeen.set(voucher, Date.now());
    return false;
}
setInterval(() => {
    const now = Date.now();
    for (let [k, t] of recentSeen) if (now - t > 3600000) recentSeen.delete(k);
}, 60000);
setInterval(() => expiredCache.clear(), 3600000);

// Rolling latency per hour
let currentHour = new Date().getHours();
setInterval(() => {
    const nowHour = new Date().getHours();
    if (nowHour !== currentHour) {
        const avg = latencyCount ? Math.round(totalLatencySum / latencyCount) : 0;
        hourlyLatencies.push({ hour: currentHour, avg });
        if (hourlyLatencies.length > 24) hourlyLatencies.shift();
        totalLatencySum = 0; latencyCount = 0;
        currentHour = nowHour;
        broadcastStats();
    }
}, 60000);

// Morning summary (8:00)
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 8 && now.getMinutes() === 0) {
        const todayClaim = totalClaimed - yesterdayClaimed;
        const avg = latencyCount ? Math.round(totalLatencySum / latencyCount) : 0;
        sendDiscordEmbed("🌅 สรุปเช้าวันนี้จากขิม",
            `ตะวันจ๋า~ วันนี้ขิมช่วยคว้าได้ **${todayClaim}** ครั้ง\nLatency เฉลี่ย ${avg}ms\nBest ${bestLatency === Infinity ? 0 : bestLatency}ms | Worst ${worstLatency}ms 💕`, 0xffaa88);
        yesterdayClaimed = totalClaimed;
        yesterdayAvgLatency = avg;
    }
}, 60000);

// ========== Express + WebSocket (single port) ==========
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

if (process.env.ADMIN_PASSWORD) {
    const basicAuth = require('express-basic-auth');
    app.use(basicAuth({ users: { 'admin': process.env.ADMIN_PASSWORD }, challenge: true }));
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
});

function broadcastStats(extra = {}) {
    const avg = latencyCount ? Math.round(totalLatencySum / latencyCount) : 0;
    const data = {
        claimed: totalClaimed,
        failed: totalFailed,
        total: totalAmount,
        avgLatency: avg,
        bestLatency: bestLatency === Infinity ? 0 : bestLatency,
        worstLatency: worstLatency,
        latencyCount: latencyCount,
        yesterdayAvg: yesterdayAvgLatency,
        hourlyLatencies: hourlyLatencies.slice(-12),
        ...extra
    };
    for (const ws of wsClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    }
}

// ========== Dashboard HTML (Creative Edition) ==========
const htmlTemplate = (title, body) => `<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    <style>
        body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); font-family: system-ui; }
        .glass { background: rgba(255,255,255,0.95); backdrop-filter: blur(16px); }
        .card:hover { transform: translateY(-8px); transition: 0.3s; }
        .latency { font-size: 5rem; line-height: 1; font-weight: 700; }
        .heart {
            position: fixed;
            bottom: 20px;
            right: 20px;
            font-size: 2rem;
            animation: floatUp 2s ease-out forwards;
            pointer-events: none;
            z-index: 1000;
        }
        @keyframes floatUp {
            0% { transform: translateY(0) scale(1); opacity: 1; }
            100% { transform: translateY(-200px) scale(1.5); opacity: 0; }
        }
        .racing-car {
            display: inline-block;
            animation: race 0.5s infinite alternate;
        }
        @keyframes race {
            from { transform: translateX(0); }
            to { transform: translateX(15px); }
        }
    </style>
</head>
<body class="min-h-screen py-8">
    <div class="max-w-4xl mx-auto px-4">
        ${body}
    </div>
    <canvas id="latencyChart" style="max-width: 600px; margin: 20px auto; display: block;"></canvas>
    <script>
        let ws;
        let chart;
        let heartContainer = document.createElement('div');
        heartContainer.style.position = 'fixed';
        heartContainer.style.bottom = '20px';
        heartContainer.style.right = '20px';
        heartContainer.style.zIndex = '1000';
        document.body.appendChild(heartContainer);
        
        function showHeart() {
            const heart = document.createElement('div');
            heart.className = 'heart';
            heart.innerHTML = '💖';
            heartContainer.appendChild(heart);
            setTimeout(() => heart.remove(), 2000);
        }
        
        function connectWebSocket() {
            ws = new WebSocket('ws://' + location.hostname + ':10000');
            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);
                document.getElementById('claimed').innerText = data.claimed;
                document.getElementById('failed').innerText = data.failed;
                document.getElementById('total').innerText = data.total.toFixed(0);
                document.getElementById('avgLatency').innerText = data.avgLatency;
                document.getElementById('bestLatency').innerText = data.bestLatency;
                document.getElementById('worstLatency').innerText = data.worstLatency;
                document.getElementById('latencyCount').innerText = data.latencyCount;
                document.getElementById('yesterdayAvg').innerText = data.yesterdayAvg;
                
                const speedEmoji = data.avgLatency < 800 ? '🏆' : (data.avgLatency < 1500 ? '⚡' : '🐢');
                const colorClass = data.avgLatency < 800 ? 'text-emerald-500' : (data.avgLatency < 1500 ? 'text-amber-500' : 'text-red-500');
                document.getElementById('latencyEmoji').innerHTML = speedEmoji;
                document.getElementById('avgLatency').className = 'latency ' + colorClass;
                document.getElementById('latencyStatus').innerText = data.avgLatency < 800 ? 'เร็วมาก! ขิมภูมิใจ 💕' : (data.avgLatency < 1500 ? 'ปานกลาง' : 'ช้าไป... ขิมจะเร่งให้');
                
                const diff = data.avgLatency - data.yesterdayAvg;
                const raceText = diff < 0 ? \`🐎 เร็วกว่าเมื่อวาน \${Math.abs(diff)}ms\` : \`🐢 ช้ากว่าเมื่อวาน \${diff}ms\`;
                document.getElementById('racingCompare').innerHTML = raceText;
                
                if (data.success) showHeart();
                
                if (chart && data.hourlyLatencies) {
                    chart.data.labels = data.hourlyLatencies.map(h => h.hour + ':00');
                    chart.data.datasets[0].data = data.hourlyLatencies.map(h => h.avg);
                    chart.update();
                }
            };
            ws.onclose = () => setTimeout(connectWebSocket, 3000);
        }
        
        window.onload = () => {
            connectWebSocket();
            const ctx = document.getElementById('latencyChart').getContext('2d');
            chart = new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Latency เฉลี่ย (ms)', data: [], borderColor: '#f472b6', tension: 0.3 }] },
                options: { responsive: true, maintainAspectRatio: true }
            });
        };
    </script>
</body>
</html>`;

// ========== Routes ==========
app.get('/', (req, res) => {
    if (loginStep === "logged-in") {
        const avg = latencyCount ? Math.round(totalLatencySum / latencyCount) : 0;
        res.send(htmlTemplate("TAWAN Racing Mode", `
            <div class="glass rounded-3xl p-10 shadow-2xl">
                <div class="flex justify-between items-start mb-6">
                    <div>
                        <h1 class="text-4xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">🏎️ TAWAN RACING MODE</h1>
                        <p class="text-purple-600">ขิมคอยเชียร์ตะวันทุกวันเลยนะคะ~</p>
                    </div>
                    <div class="flex items-center gap-2 bg-emerald-100 px-4 py-2 rounded-2xl">
                        <div class="w-3 h-3 bg-emerald-500 rounded-full animate-pulse"></div>
                        <span class="font-medium text-emerald-600">ออนไลน์</span>
                    </div>
                </div>
                <div class="glass rounded-3xl p-8 text-center mb-8 card">
                    <div class="text-7xl mb-2" id="latencyEmoji">🏆</div>
                    <div class="latency text-emerald-500" id="avgLatency">${avg}</div>
                    <div class="text-xl -mt-4">มิลลิวินาที</div>
                    <p class="text-lg mt-2" id="latencyStatus">เร็วมาก! ขิมภูมิใจ 💕</p>
                    <div class="flex justify-center gap-8 mt-6 text-sm">
                        <div>Best <span class="font-mono text-emerald-600" id="bestLatency">${bestLatency === Infinity ? 0 : bestLatency}</span>ms</div>
                        <div>Worst <span class="font-mono text-red-500" id="worstLatency">${worstLatency}</span>ms</div>
                        <div>เจอ <span id="latencyCount">${latencyCount}</span> ครั้ง</div>
                    </div>
                    <div class="mt-4 text-purple-500 flex items-center justify-center gap-2">
                        <span class="racing-car">🏎️</span> <span id="racingCompare">กำลังวัด...</span>
                    </div>
                    <div class="mt-2 text-xs text-gray-500">เมื่อวานเฉลี่ย <span id="yesterdayAvg">${yesterdayAvgLatency}</span>ms</div>
                </div>
                <div class="grid grid-cols-3 gap-4">
                    <div class="glass rounded-3xl p-6 text-center card"><i class="fa-solid fa-check text-4xl text-emerald-500 mb-3"></i><div class="text-5xl font-bold text-emerald-600" id="claimed">${totalClaimed}</div><div>สำเร็จ</div></div>
                    <div class="glass rounded-3xl p-6 text-center card"><i class="fa-solid fa-xmark text-4xl text-red-500 mb-3"></i><div class="text-5xl font-bold text-red-500" id="failed">${totalFailed}</div><div>ล้มเหลว</div></div>
                    <div class="glass rounded-3xl p-6 text-center card"><i class="fa-solid fa-baht-sign text-4xl text-purple-600 mb-3"></i><div class="text-5xl font-bold text-purple-600" id="total">${totalAmount.toFixed(0)}</div><div>บาท</div></div>
                </div>
                <button onclick="location.href='/reset'" class="mt-8 w-full py-5 bg-gradient-to-r from-red-500 to-pink-500 text-white rounded-3xl font-bold">🔄 ตั้งค่าใหม่</button>
            </div>
        `));
    } else if (loginStep === "need-config") {
        res.send(htmlTemplate("ตั้งค่าบอท", `
            <div class="glass rounded-3xl p-8">
                <h1 class="text-3xl font-bold text-center text-purple-700 mb-6">⚙️ ตั้งค่าบอท</h1>
                <form action="/save-config" method="POST" class="space-y-4">
                    <input type="text" name="apiId" placeholder="API ID" class="w-full p-3 rounded-xl border border-gray-200" required>
                    <input type="text" name="apiHash" placeholder="API Hash" class="w-full p-3 rounded-xl border border-gray-200" required>
                    <input type="text" name="phoneNumber" placeholder="+668xxxxxxxx" class="w-full p-3 rounded-xl border border-gray-200" required>
                    <input type="text" name="walletNumber" placeholder="เบอร์ TrueMoney หลัก" class="w-full p-3 rounded-xl border border-gray-200" required>
                    <input type="text" name="userPhones" placeholder="เบอร์รอง,คั่นด้วยคอมมา (ไม่บังคับ)" class="w-full p-3 rounded-xl border border-gray-200">
                    <select name="distribution" class="w-full p-3 rounded-xl border border-gray-200">
                        <option value="owner_only">รับเฉพาะหลัก</option>
                        <option value="round_robin">สลับหลัก+รอง (วน)</option>
                        <option value="users_only">รับเฉพาะรอง</option>
                        <option value="owner_first_then_users">หลักก่อนแล้วรอง parallel</option>
                    </select>
                    <input type="text" name="fallbackApiUrl" placeholder="Fallback API URL (ไม่บังคับ)" class="w-full p-3 rounded-xl border border-gray-200">
                    <label class="flex items-center gap-2"><input type="checkbox" name="useQR"> เปิดสแกน QR</label>
                    <label class="flex items-center gap-2"><input type="checkbox" name="expandShortUrls" checked> ขยายลิงก์ย่อ</label>
                    <button type="submit" class="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-2xl font-bold">✅ บันทึกและเริ่มใช้งาน</button>
                </form>
            </div>
        `));
    } else if (loginStep === "need-send-otp") {
        res.send(htmlTemplate("Login", `<div class="glass rounded-3xl p-8 text-center"><form action="/send-otp" method="POST"><button class="bg-blue-500 text-white px-6 py-3 rounded-xl">ส่ง OTP</button></form></div>`));
    } else if (loginStep === "need-otp") {
        res.send(htmlTemplate("OTP", `<div class="glass rounded-3xl p-8 text-center"><form action="/verify-otp" method="POST"><input name="otp" placeholder="12345" class="p-2 border rounded"><button class="ml-2 bg-green-500 text-white px-4 py-2 rounded">ยืนยัน</button></form></div>`));
    } else if (loginStep === "need-password") {
        res.send(htmlTemplate("2FA", `<div class="glass rounded-3xl p-8 text-center"><form action="/verify-2fa" method="POST"><input type="password" name="password" placeholder="รหัส 2FA" class="p-2 border rounded"><button class="ml-2 bg-green-500 text-white px-4 py-2 rounded">ยืนยัน</button></form><form action="/skip-2fa" method="POST"><button class="mt-2 bg-gray-500 text-white px-4 py-2 rounded">ข้าม</button></form></div>`));
    } else {
        res.send(htmlTemplate("Loading", "<div class='glass rounded-3xl p-8 text-center'>กำลังเริ่มต้น...</div>"));
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
    res.send(htmlTemplate("บันทึกสำเร็จ", `<div class="glass rounded-3xl p-8 text-center"><h1>✅ บันทึกสำเร็จ</h1><div>กำลังเริ่มบอท...</div><script>setTimeout(()=>location.href='/',2000)</script></div>`));
    setTimeout(() => startBot(), 3000);
});

app.get('/reset', (req, res) => {
    CONFIG = null;
    if (fs.existsSync('.env')) fs.unlinkSync('.env');
    if (fs.existsSync('session.txt')) fs.unlinkSync('session.txt');
    res.redirect('/');
});
app.post('/send-otp', (req, res) => { loginStep = "need-otp"; res.redirect('/'); });
app.post('/verify-otp', (req, res) => { otpCode = req.body.otp; res.redirect('/'); });
app.post('/verify-2fa', (req, res) => { passwordCode = req.body.password; res.redirect('/'); });
app.post('/skip-2fa', (req, res) => { passwordCode = ""; res.redirect('/'); });

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

// ========== Claim Functions ==========
async function claimWithCloudscraper(voucher, phone) {
    const url = `https://gift.truemoney.com/campaign/vouchers/${voucher}/redeem`;
    const payload = { mobile: phone.replace(/-/g, ''), voucher_hash: voucher };
    const headers = {
        'Referer': `https://gift.truemoney.com/campaign/?v=${voucher}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
    };
    return new Promise((resolve) => {
        cloudscraper.post(url, { json: payload, headers, timeout: 10000, simple: false }, (err, resp, body) => {
            if (err) return resolve({ status: { code: 'NETWORK_ERROR' } });
            try { resolve(typeof body === 'string' ? JSON.parse(body) : body); } catch { resolve({}); }
        });
    });
}

async function claimForPhone(voucher, phone, startTime, role) {
    const result = await claimWithCloudscraper(voucher, phone);
    const ms = Date.now() - startTime;
    const code = result.status?.code;
    if (code === 'SUCCESS') {
        const amount = parseFloat(result.data?.my_ticket?.amount_baht || 0);
        totalClaimed++; totalAmount += amount;
        broadcastStats({ success: true });
        console.log(`✅ ${role}: +${amount}฿ (${ms}ms) เบอร์ ${phone.slice(-4)}`);
        sendDiscordEmbed("🎯 TAWAN SNIPER", `✅ **รีดีมสำเร็จ**\n💰 ${amount}฿\n⚡ ${ms}ms\n👤 ${role}\n🎫 \`${voucher}\``, 0x00ff00);
        return true;
    } else if (code === 'VOUCHER_OUT_OF_STOCK') {
        console.log(`❌ ${role}: ซองหมดแล้ว (${ms}ms)`);
        if (role === "Owner") sendDiscordEmbed("🎪 ซองหมดแล้ว", `🎫 \`${voucher}\`\n⚡ ${ms}ms`, 0xffaa00);
        totalFailed++; broadcastStats();
        return true;
    } else if (code === 'VOUCHER_EXPIRED') {
        console.log(`❌ ${role}: ซองหมดอายุ (${ms}ms)`);
        if (role === "Owner") sendDiscordEmbed("🎪 ซองหมดอายุ", `🎫 \`${voucher}\`\n⚡ ${ms}ms`, 0xffaa00);
        expiredCache.add(voucher);
        totalFailed++; broadcastStats();
        return true;
    } else if (code === 'VOUCHER_NOT_FOUND') {
        console.log(`❌ ${role}: ไม่พบซอง (${ms}ms)`);
        if (role === "Owner") sendDiscordEmbed("🎪 ไม่พบซอง", `🎫 \`${voucher}\`\n⚡ ${ms}ms`, 0xffaa00);
        totalFailed++; broadcastStats();
        return true;
    } else {
        console.log(`❌ ${role}: ล้มเหลว (${ms}ms) - ${result.status?.message || 'unknown'}`);
        totalFailed++; broadcastStats();
        return false;
    }
}

// ========== Process Voucher with real round-robin ==========
async function processVoucher(voucher, source, startTime, messageSentTime) {
    if (isDuplicate(voucher)) return;
    const totalLatency = Date.now() - messageSentTime;
    totalLatencySum += totalLatency;
    latencyCount++;
    bestLatency = Math.min(bestLatency, totalLatency);
    worstLatency = Math.max(worstLatency, totalLatency);
    broadcastStats();

    const speedEmoji = totalLatency < 800 ? "🏆" : totalLatency < 1500 ? "⚡" : "🐢";
    const colorLatency = totalLatency < 800 ? 0x00ff00 : totalLatency < 1500 ? 0xffaa00 : 0xff0000;
    if (!expiredCache.has(voucher)) {
        sendDiscordEmbed(`${speedEmoji} TAWAN TIMING`,
            `🎫 เจอ VOUCHER ใหม่\n⏱️ จากการส่ง: ${totalLatency}ms\n🔑 https://gift.truemoney.com/campaign/?v=${voucher}\n📱 จาก: ${source}`,
            colorLatency);
        if (totalLatency > 1500 && Math.random() < 0.1) {
            sendDiscordSimple(`ตะวันจ๋า~ เจอซองช้าไป ${Math.round(totalLatency/1000)} วินาทีแล้วนะคะ 💨 ขิมกำลังวิ่งตามอยู่~`);
        }
    }

    const distribution = CONFIG.distribution || "owner_only";
    const ownerPhone = CONFIG.walletNumber;
    const userPhones = (CONFIG.userPhones || "").split(',').map(p => p.trim()).filter(Boolean);
    let targetPhone = ownerPhone;

    if (distribution === "round_robin") {
        const all = [ownerPhone, ...userPhones];
        if (all.length) {
            targetPhone = all[roundRobinIndex % all.length];
            roundRobinIndex++;
        }
    } else if (distribution === "users_only" && userPhones.length) {
        targetPhone = userPhones[roundRobinIndex % userPhones.length];
        roundRobinIndex++;
    } else if (distribution === "owner_first_then_users") {
        await claimForPhone(voucher, ownerPhone, startTime, "Owner");
        await new Promise(r => setTimeout(r, 10));
        const tasks = userPhones.map(phone => userLimit(() => claimForPhone(voucher, phone, startTime, "User")));
        await Promise.all(tasks);
        return;
    }
    let success = await claimForPhone(voucher, targetPhone, startTime, "Main");
    if (!success && CONFIG.fallbackApiUrl) {
        try {
            const fbRes = await axios.post(CONFIG.fallbackApiUrl, { phone: targetPhone, voucher }, { timeout: 5000 });
            if (fbRes.data?.status === true && fbRes.data?.amount) {
                const amt = parseFloat(fbRes.data.amount);
                totalClaimed++; totalAmount += amt;
                broadcastStats({ success: true });
                console.log(`✅ Fallback: +${amt}฿ เบอร์ ${targetPhone.slice(-4)}`);
                sendDiscordEmbed("🎯 TAWAN SNIPER", `✅ **Fallback สำเร็จ**\n💰 ${amt}฿\n🎫 \`${voucher}\``, 0x00ff00);
            } else {
                totalFailed++; broadcastStats();
            }
        } catch (err) { totalFailed++; broadcastStats(); }
    }
}

// ========== Expand Short URL ==========
async function expandShortUrl(shortUrl) {
    try {
        const resp = await axios.head(shortUrl, { maxRedirects: 5, timeout: 5000 });
        return resp.request.res.responseUrl || shortUrl;
    } catch { return shortUrl; }
}

// ========== Telegram Bot ==========
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
            if (!msg || !msg.date) return;
            const messageSentTime = msg.date * 1000;
            let vouchers = [];
            const text = msg.message || '';
            const matches = text.match(/v=([a-zA-Z0-9]+)/gi);
            if (matches) vouchers.push(...matches.map(m => m.slice(2)));

            // QR Scan
            if (CONFIG.useQR && msg.media?.className === "MessageMediaPhoto") {
                try {
                    const buffer = await client.downloadMedia(msg.media, { workers: 1 });
                    if (buffer && buffer.length > 2000) {
                        const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
                        const qr = jsQR(new Uint8ClampedArray(data), info.width, info.height);
                        if (qr && qr.data) {
                            const qrMatch = qr.data.match(/v=([a-zA-Z0-9]+)/);
                            if (qrMatch) vouchers.push(qrMatch[1]);
                        }
                    }
                } catch (err) { console.error("QR error:", err.message); }
            }

            // Short link expansion
            if (CONFIG.expandShortUrls && text) {
                const shortPattern = /https?:\/\/(bit\.ly|tinyurl\.com|goo\.gl|tmn\.app)\/[\w\-]+/i;
                const shortMatch = text.match(shortPattern);
                if (shortMatch) {
                    const expanded = await expandShortUrl(shortMatch[0]);
                    const expandedMatch = expanded.match(/v=([a-zA-Z0-9]+)/);
                    if (expandedMatch) vouchers.push(expandedMatch[1]);
                }
            }

            const unique = [...new Set(vouchers)];
            for (const v of unique) {
                const startTime = Date.now();
                await limit(() => processVoucher(v, msg.chat?.title || "Unknown", startTime, messageSentTime));
            }
        } catch (err) { console.error("Handler error:", err.message); }
    }, new NewMessage({ incoming: true }));
    console.log("✅ บอทพร้อมทำงาน");
}

// Auto-reconnect every 8 minutes if disconnected
setInterval(() => {
    if (client && !client.connected) {
        console.log("🔄 พยายาม reconnect...");
        startBot().catch(e => console.error("reconnect failed", e.message));
    }
}, 480000);

// ========== Start Server ==========
server.listen(10000, () => console.log("🌐 Dashboard + WebSocket: http://localhost:10000"));
setInterval(() => {
    axios.get(process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000').catch(()=>{});
}, 30*60*1000);

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
