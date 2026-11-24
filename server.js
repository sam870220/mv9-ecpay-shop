require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PROD = process.env.ECPAY_ENV === 'prod';

const AIO_URL = IS_PROD
  ? 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'
  : 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5';

const INVOICE_URL = IS_PROD
  ? 'https://einvoice.ecpay.com.tw/B2CInvoice/Issue'
  : 'https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue';

const UNIT_PRICE = 1198;
const ORDERS_FILE = path.join(__dirname, 'orders.json');

function readOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeOrders(data) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 綠界 AIO 金流專用 URL Encode（小寫 + .NET 字元替換）
function ecpayUrlEncode(str) {
  return encodeURIComponent(str)
    .toLowerCase()
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')');
}

// 計算綠界 AIO CheckMacValue (SHA256)
function generateCheckMacValue(params, hashKey, hashIV) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => a.localeCompare(b));
  const raw = `HashKey=${hashKey}&${keys.map((k) => `${k}=${params[k]}`).join('&')}&HashIV=${hashIV}`;
  const encoded = ecpayUrlEncode(raw);
  return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
}

// 使用 timingSafeEqual 驗證 CheckMacValue
function verifyCheckMacValue(params, hashKey, hashIV) {
  const received = String(params.CheckMacValue || '').toUpperCase();
  const expected = generateCheckMacValue(params, hashKey, hashIV);
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// 綠界 B2C 電子發票 AES-128-CBC 加密
function encryptInvoiceData(dataObj, hashKey, hashIV) {
  const urlEncoded = encodeURIComponent(JSON.stringify(dataObj));
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(hashKey, 'utf8'), Buffer.from(hashIV, 'utf8'));
  let encrypted = cipher.update(urlEncoded, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function decryptInvoiceData(base64Str, hashKey, hashIV) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(hashKey, 'utf8'), Buffer.from(hashIV, 'utf8'));
  let decrypted = decipher.update(base64Str, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decodeURIComponent(decrypted));
}

// 呼叫綠界 B2C 電子發票開立 API
async function issueB2CInvoice(order) {
  const merchantId = process.env.ECPAY_INV_MERCHANT_ID;
  const hashKey = process.env.ECPAY_INV_HASH_KEY;
  const hashIV = process.env.ECPAY_INV_HASH_IV;

  let CarrierType = '';
  let CarrierNum = '';
  let Donation = '0';
  let LoveCode = '';
  let CustomerIdentifier = '';
  let Print = '0';

  if (order.invoiceType === 'carrier') {
    if (order.carrierNum) {
      CarrierType = '3';
      CarrierNum = order.carrierNum;
    } else {
      CarrierType = '1'; // 綠界會員載具
    }
  } else if (order.invoiceType === 'company') {
    CustomerIdentifier = order.taxId || '';
    Print = '1';
  } else if (order.invoiceType === 'donation') {
    Donation = '1';
    LoveCode = order.loveCode || '168001';
  }

  const invoicePayload = {
    MerchantID: merchantId,
    RelateNumber: order.tradeNo,
    CustomerID: '',
    CustomerIdentifier,
    CustomerName: order.name,
    CustomerAddr: order.address,
    CustomerPhone: order.phone,
    CustomerEmail: order.email,
    ClearanceMark: '',
    Print,
    Donation,
    LoveCode,
    CarrierType,
    CarrierNum,
    TaxType: '1',
    SalesAmount: order.amount,
    InvoiceRemark: 'MV9定位修改器訂單自動開立',
    Items: [
      {
        ItemSeq: 1,
        ItemName: 'MV9定位修改器',
        ItemCount: order.quantity,
        ItemWord: '台',
        ItemPrice: UNIT_PRICE,
        ItemTaxType: '1',
        ItemAmount: order.amount
      }
    ],
    InvType: '07',
    vat: '1'
  };

  const requestBody = {
    MerchantID: merchantId,
    RqHeader: {
      Timestamp: Math.floor(Date.now() / 1000),
      Revision: '3.0.0'
    },
    Data: encryptInvoiceData(invoicePayload, hashKey, hashIV)
  };

  const resp = await fetch(INVOICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  const json = await resp.json();
  if (json.TransCode !== 1) {
    throw new Error(`電子發票傳輸失敗: ${json.TransMsg}`);
  }
  const result = decryptInvoiceData(json.Data, hashKey, hashIV);
  if (result.RtnCode !== 1) {
    throw new Error(`電子發票開立失敗: ${result.RtnMsg}`);
  }
  return result;
}

// 寄送訂單成立通知信給買家
async function sendOrderConfirmationEmail(order) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('[Email] 未設定 SMTP，略過寄信:', order.email);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: order.email,
    subject: `【牛牛科技工作室】訂單成立通知 (${order.tradeNo}) — 電子發票已開立`,
    html: `
      <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; color: #1e293b;">
        <h2>${order.name} 您好，您的訂單已成立！</h2>
        <p>我們已收到您的綠界科技付款確認，並已自動為您開立電子發票：</p>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
          <p><strong>訂單編號：</strong>${order.tradeNo}</p>
          <p><strong>訂購商品：</strong>MV9 定位修改器 × ${order.quantity} 台</p>
          <p><strong>實付金額：</strong>NT$ ${order.amount.toLocaleString()}</p>
          <p><strong>收件資訊：</strong>${order.name} / ${order.phone} / ${order.address}</p>
          <p><strong>電子發票號碼：</strong>${order.invoiceNo || '處理中'}</p>
        </div>
        <p style="font-size: 13px; color: #64748b; margin-top: 16px;">
          如有任何問題，歡迎加入官方 LINE：@738xffib 與我們聯繫。
        </p>
      </div>
    `
  });
}

// 1. 建立暫存訂單並產生導向綠界收銀台的 HTML 表單
app.post('/api/orders', (req, res) => {
  const { name, phone, address, email, quantity = 1, paymentMethod = 'ALL', invoiceType = 'carrier', carrierNum = '', taxId = '', loveCode = '168001' } = req.body;
  if (!name || !phone || !address || !email) {
    return res.status(400).json({ error: '請完整填寫姓名、電話、地址與 Email' });
  }

  const qty = Math.max(1, Math.min(10, Number(quantity) || 1));
  const amount = UNIT_PRICE * qty;
  const tradeNo = `MV9${Date.now().toString().slice(-10)}${Math.floor(1000 + Math.random() * 9000)}`;
  const now = new Date();
  const tradeDate = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const orders = readOrders();
  orders[tradeNo] = {
    tradeNo,
    name,
    phone,
    address,
    email,
    quantity: qty,
    amount,
    paymentMethod,
    invoiceType,
    carrierNum,
    taxId,
    loveCode,
    status: 'PENDING', // 買家確認付款前皆為未成立
    invoiceNo: null,
    paidAt: null
  };
  writeOrders(orders);

  const ecpayParams = {
    MerchantID: process.env.ECPAY_MERCHANT_ID,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: tradeDate,
    PaymentType: 'aio',
    TotalAmount: amount,
    TradeDesc: 'MV9定位修改器',
    ItemName: `MV9定位修改器 x ${qty}`,
    ReturnURL: `${BASE_URL}/api/ecpay/return`,
    ClientBackURL: `${BASE_URL}/?tradeNo=${tradeNo}`,
    ChoosePayment: paymentMethod,
    EncryptType: 1
  };
  ecpayParams.CheckMacValue = generateCheckMacValue(
    ecpayParams,
    process.env.ECPAY_HASH_KEY,
    process.env.ECPAY_HASH_IV
  );

  const inputs = Object.entries(ecpayParams)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}" />`)
    .join('\n');

  res.send(`<!DOCTYPE html><html><body>
    <form id="ecpayForm" method="POST" action="${AIO_URL}">${inputs}</form>
    <script>document.getElementById('ecpayForm').submit();</script>
  </body></html>`);
});

// 2. 接收綠界 Server-to-Server 付款結果通知 (ReturnURL)
app.post('/api/ecpay/return', async (req, res) => {
  const params = req.body;
  const valid = verifyCheckMacValue(params, process.env.ECPAY_HASH_KEY, process.env.ECPAY_HASH_IV);
  if (!valid) {
    return res.status(400).send('0|CheckMacValue Error');
  }

  const tradeNo = params.MerchantTradeNo;
  const orders = readOrders();
  const order = orders[tradeNo];

  if (order && params.RtnCode === '1' && order.status !== 'PAID') {
    order.status = 'PAID';
    order.paidAt = new Date().toISOString();

    try {
      const invRes = await issueB2CInvoice(order);
      order.invoiceNo = invRes.InvoiceNo;
    } catch (err) {
      console.error('[Invoice Error]', err.message);
    }

    writeOrders(orders);

    try {
      await sendOrderConfirmationEmail(order);
    } catch (err) {
      console.error('[Mail Error]', err.message);
    }
  }

  res.send('1|OK');
});

// 3. 查詢單筆訂單狀態
app.get('/api/orders/:tradeNo', (req, res) => {
  const orders = readOrders();
  const order = orders[req.params.tradeNo];
  if (!order) return res.status(404).json({ error: '查無此訂單' });
  res.json(order);
});

app.listen(PORT, () => {
  console.log(`MV9 綠界金流與電子發票商店已啟動：http://localhost:${PORT}`);
});
