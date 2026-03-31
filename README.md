# Telegram-Bot สำหรับ TrueMoney Auto Claim

บอทอัตโนมัติสำหรับรับ TrueMoney Gift Voucher ผ่าน Telegram  
โดยใช้ `@fortune-inc/tw-voucher` รีดีมโดยตรง ไม่ต้องผ่าน Proxy  
รันบน **Render** ฟรี 24/7 (พร้อมวิธีป้องกันการหลับ)

---

## 📌 สิ่งที่ต้องมีล่วงหน้า

- บัญชี **Telegram**
- **เบอร์โทร** ที่ใช้กับ Telegram
- **เบอร์ TrueMoney Wallet** สำหรับรับเงิน
- บัญชี **Google** (สำหรับสมัคร Render)

---

## 🚀 ขั้นตอนที่ 1: สมัคร Render (รันบอท 24/7)

1. ไปที่ [https://render.com](https://render.com)
2. คลิก **Get Started** / **Sign Up**
3. เลือก **Sign up with Google**
   > แนะนำ: สมัครง่าย ไม่ต้องตั้งค่าอะไรเพิ่ม
4. เข้าสู่ระบบด้วยบัญชี Google ของคุณ

---

## 🚀 ขั้นตอนที่ 2: สร้าง Web Service

1. ที่หน้า Dashboard ของ Render คลิก **New +**
2. เลือก **Web Service**
3. ในช่อง **Public Git repository** ให้ใส่ URL:
   ```
   https://github.com/NONAMEHUB0212/testbro/tree/main
   ```
4. คลิก **Connect**

---

## 🚀 ขั้นตอนที่ 3: ตั้งค่า Web Service

กรอกข้อมูลตามนี้ทุกบรรทัด:

| ช่อง | ค่าที่ต้องใส่ |
|------|--------------|
| **Name** | `truemoney-bot` (หรือชื่อที่ต้องการ) |
| **Environment** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | `Free` |

กด **Create Web Service**  
รอระบบ build และ deploy (ประมาณ 2-3 นาที)

---

## 🚀 ขั้นตอนที่ 4: รอ Deploy เสร็จ

- เมื่อสถานะขึ้น **Live** สีเขียว แสดงว่าพร้อมใช้งาน  
- คัดลอก URL ที่ Render ให้ เช่น  
  ```
  https://truemoney-bot-xxxx.onrender.com
  ```

---

## 🚀 ขั้นตอนที่ 5: สมัคร Telegram API

1. ไปที่ [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. เข้าสู่ระบบด้วยเบอร์ Telegram (รับ OTP ทางแอปฯ)
3. เลือก **API development tools**
4. กรอกข้อมูล:
   - **App title**: `TrueMoney Bot`
   - **Short name**: `tmbot`
   - **Platform**: `Desktop`
   - **Description**: (เว้นว่าง)
5. กด **Create application**
6. จด **api_id** (ตัวเลข) และ **api_hash** (รหัสยาว) ไว้

---

## 🚀 ขั้นตอนที่ 6: ตั้งค่าบอทผ่านหน้าเว็บ

1. เปิด URL ที่ได้จาก Render
2. หน้าแรกคือ **ตั้งค่าบอท**  
   กรอกข้อมูลดังนี้:

   - **🔑 API ID** – ตัวเลขจาก my.telegram.org
   - **🔐 API Hash** – รหัสยาวจาก my.telegram.org
   - **📱 เบอร์ Telegram** – ต้องขึ้นต้นด้วย `+66` (เช่น `+66812345678`)
   - **💰 เบอร์ TrueMoney Wallet** – เริ่มต้นด้วย `0` (เช่น `0812345678`)
   - **📝 ชื่อกระเป๋า** – ไม่บังคับ

3. กด **✅ บันทึกและเริ่มใช้งาน**

ระบบจะบันทึกข้อมูลลงในไฟล์ `.env` และเริ่มกระบวนการล็อกอิน Telegram

---

## 🚀 ขั้นตอนที่ 7: ล็อกอิน Telegram

- หน้าเว็บจะเปลี่ยนไปขอ **ส่ง OTP**
- กด **📨 ส่ง OTP** – รอรับรหัสในแอป Telegram
- ใส่รหัส OTP แล้วกด **✅ ยืนยัน**

**กรณีมี 2FA:**  
- จะมีหน้าให้ใส่รหัส 2FA  
- ใส่รหัสแล้วกด **✅ ยืนยัน**  
- หรือถ้าไม่มี 2FA ให้กด **⏭️ ข้าม**

---

## 🚀 ขั้นตอนที่ 8: เริ่มใช้งาน

เมื่อล็อกอินสำเร็จ หน้าเว็บจะแสดง Dashboard:

```
🚀 TrueMoney Bot
✅ บอทกำลังทำงาน

┌─────────┬─────────┬─────────┐
│รับสำเร็จ │ล้มเหลว  │ยอดรวม   │
│   0     │   0     │   0฿    │
└─────────┴─────────┴─────────┘

📱 เบอร์: +668xxxxxxxx
💰 กระเป๋า: กระเป๋าหลัก
```

บอทจะทำงานทันที – คอยฟังข้อความและ QR Code ใน Telegram  
เมื่อพบลิงก์ `gift.truemoney.com/campaign/?v=...` จะรีดีมเงินเข้ากระเป๋า TrueMoney โดยอัตโนมัติ

---

## 🛌 ป้องกัน Render Sleep (แนะนำ)

Render Free Tier จะหยุดทำงานหากไม่มี Request เข้า 30 นาที  
เพื่อให้บอททำงานตลอดเวลา ให้ใช้ **UptimeRobot** หรือบริการ ping ฟรี:

1. ไปที่ [https://uptimerobot.com](https://uptimerobot.com)
2. สมัครฟรี
3. เพิ่ม **Monitor**:
   - **Monitor Type**: `HTTP(s)`
   - **URL**: URL ของบอท (ที่ได้จาก Render)
   - **Interval**: `10 minutes`
4. กด **Create Monitor**

---

## 🔧 การแก้ปัญหาเบื้องต้น

| ปัญหา | วิธีแก้ |
|--------|--------|
| **หน้าเว็บไม่ขึ้น** | ตรวจสอบว่า Render ขึ้นสถานะ Live, รอ 1-2 นาทีแล้ว Refresh |
| **Login ไม่ได้** | ตรวจสอบ API ID / API Hash, เบอร์ต้องขึ้นต้นด้วย `+66` ถ้าติดปัญหาให้กด **ตั้งค่าใหม่** ที่หน้า Dashboard |
| **OTP ไม่มา** | ตรวจสอบเบอร์ Telegram, ดูข้อความใน Telegram, กดส่ง OTP ใหม่ |
| **บอทไม่ทำงาน** | ตรวจสอบว่า Dashboard ขึ้น ✅ **บอทกำลังทำงาน**, ดู Logs ที่ Render |
| **รีดีมไม่สำเร็จ** | ตรวจสอบเบอร์ TrueMoney Wallet ว่าถูกต้องและผูกกับ TrueMoney แล้ว, ตรวจสอบว่า voucher ยังไม่หมดอายุ |

---

## 📦 โครงสร้างโค้ด (สำหรับผู้ที่ต้องการพัฒนาเอง)

```
truemoney-bot/
├── index.js          (ตัวเรียกหลัก)
├── bot.js            (โค้ดหลัก – Telegram client, Express web, QR decode, redemption)
├── package.json      (dependencies)
├── .env.example      (ตัวอย่างไฟล์ environment)
└── README.md         (คู่มือนี้)
```

**Dependencies สำคัญ:**
- `telegram` – MTProto client สำหรับ Telegram
- `express` – จัดการหน้าเว็บ
- `sharp` – ประมวลผลรูปภาพ (QR code) เร็วและประหยัดทรัพยากร
- `jsqr` – ถอดรหัส QR code
- `@fortune-inc/tw-voucher` – รีดีม TrueMoney โดยตรง
- `p-limit` – จำกัดการทำงานพร้อมกัน

---

## 📝 หมายเหตุ

- ใช้งานได้ทันทีจาก **Public Repository**  
  ❌ ไม่ต้อง Fork  
  ❌ ไม่ต้องอัปโหลดไฟล์เอง  
  ❌ ไม่ต้องเขียนโค้ด  
- ระบบจะสร้างไฟล์ `.env` และ `session.txt` อัตโนมัติหลังตั้งค่า  
- ทุกครั้งที่เริ่มต้นใหม่ บอทจะใช้ session ที่บันทึกไว้เพื่อล็อกอินอัตโนมัติ  

---

## 👨‍💻 ผู้พัฒนา

**tawan_x2noban** – ออกแบบและพัฒนาโค้ดให้ทำงานเร็ว ใช้ทรัพยากรน้อย  
พร้อมให้คำปรึกษาฟรี (ถ้าติดปัญหาสามารถสอบถามผ่านช่องทางที่ระบุ)

---

**เริ่มต้นใช้งานได้ทันที ไม่มีค่าใช้จ่าย**  
บอทจะคอยรับเงินให้คุณตลอด 24 ชั่วโมง 🎉
