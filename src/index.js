const UNIT_PRICE = 1198;
const memoryOrders = new Map();

async function saveOrder(env, tradeNo, order) {
  memoryOrders.set(tradeNo, order);
  if (env.ORDERS_KV) {
    await env.ORDERS_KV.put(tradeNo, JSON.stringify(order));
  }
}

async function getOrder(env, tradeNo) {
  if (env.ORDERS_KV) {
    const raw = await env.ORDERS_KV.get(tradeNo);
    if (raw) return JSON.parse(raw);
  }
  return memoryOrders.get(tradeNo) || null;
}

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

async function sha256HexUpper(text) {
  const bytes = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

async function generateCheckMacValue(params, hashKey, hashIV) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => a.localeCompare(b));
  const raw = `HashKey=${hashKey}&${keys.map((k) => `${k}=${params[k]}`).join('&')}&HashIV=${hashIV}`;
  return sha256HexUpper(ecpayUrlEncode(raw));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyCheckMacValue(params, hashKey, hashIV) {
  const received = String(params.CheckMacValue || '').toUpperCase();
  const expected = await generateCheckMacValue(params, hashKey, hashIV);
  return constantTimeEqual(received, expected);
}

function toBase64(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function encryptInvoiceData(dataObj, hashKey, hashIV) {
  const encoded = encodeURIComponent(JSON.stringify(dataObj));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hashKey),
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: new TextEncoder().encode(hashIV) },
    key,
    new TextEncoder().encode(encoded)
  );
  return toBase64(new Uint8Array(encrypted));
}

async function decryptInvoiceData(base64Str, hashKey, hashIV) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hashKey),
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: new TextEncoder().encode(hashIV) },
    key,
    fromBase64(base64Str)
  );
  const decodedText = new TextDecoder().decode(decrypted);
  return JSON.parse(decodeURIComponent(decodedText));
}

async function issueB2CInvoice(env, order) {
  const isProd = env.ECPAY_ENV === 'prod';
  const invoiceUrl = isProd
    ? 'https://einvoice.ecpay.com.tw/B2CInvoice/Issue'
    : 'https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue';

  const merchantId = env.ECPAY_INV_MERCHANT_ID || '2000132';
  const hashKey = env.ECPAY_INV_HASH_KEY || 'ejCk326UnaZWKisg';
  const hashIV = env.ECPAY_INV_HASH_IV || 'q9jcZX8Ib9LM8wYk';

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
      CarrierType = '1';
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

  const body = {
    MerchantID: merchantId,
    RqHeader: {
      Timestamp: Math.floor(Date.now() / 1000),
      Revision: '3.0.0'
    },
    Data: await encryptInvoiceData(invoicePayload, hashKey, hashIV)
  };

  const resp = await fetch(invoiceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.TransCode !== 1) {
    throw new Error(`電子發票傳輸失敗: ${json.TransMsg}`);
  }
  const result = await decryptInvoiceData(json.Data, hashKey, hashIV);
  if (result.RtnCode !== 1) {
    throw new Error(`電子發票開立失敗: ${result.RtnMsg}`);
  }
  return result;
}

async function sendOrderConfirmationEmail(env, order) {
  if (!env.RESEND_API_KEY) {
    console.log('[Email] 未設定 RESEND_API_KEY，略過寄信:', order.email);
    return;
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || '牛牛科技工作室 <onboarding@resend.dev>',
      to: [order.email],
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
    })
  });
  if (!resp.ok) {
    console.error('[Resend Error]', await resp.text());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const baseUrl = (env.BASE_URL || url.origin).replace(/\/$/, '');
    const isProd = env.ECPAY_ENV === 'prod';
    const aioUrl = isProd
      ? 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'
      : 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5';

    // 1. 建立待付款訂單並回傳導向綠界收銀台之自動送出表單
    if (request.method === 'POST' && url.pathname === '/api/orders') {
      const data = await request.json();
      const {
        name, phone, address, email,
        quantity = 1, paymentMethod = 'ALL',
        invoiceType = 'carrier', carrierNum = '', taxId = '', loveCode = '168001'
      } = data;

      if (!name || !phone || !address || !email) {
        return Response.json({ error: '請完整填寫姓名、電話、地址與 Email' }, { status: 400 });
      }

      const qty = Math.max(1, Math.min(10, Number(quantity) || 1));
      const amount = UNIT_PRICE * qty;
      const tradeNo = `MV9${Date.now().toString().slice(-10)}${Math.floor(1000 + Math.random() * 9000)}`;

      // 台灣時間 (GMT+8)
      const tw = new Date(Date.now() + 8 * 3600 * 1000);
      const tradeDate = `${tw.getUTCFullYear()}/${String(tw.getUTCMonth() + 1).padStart(2, '0')}/${String(tw.getUTCDate()).padStart(2, '0')} ${String(tw.getUTCHours()).padStart(2, '0')}:${String(tw.getUTCMinutes()).padStart(2, '0')}:${String(tw.getUTCSeconds()).padStart(2, '0')}`;

      const order = {
        tradeNo, name, phone, address, email,
        quantity: qty, amount, paymentMethod,
        invoiceType, carrierNum, taxId, loveCode,
        status: 'PENDING',
        invoiceNo: null,
        paidAt: null
      };
      await saveOrder(env, tradeNo, order);

      const merchantId = env.ECPAY_MERCHANT_ID || '3002607';
      const hashKey = env.ECPAY_HASH_KEY || 'pwFHCqoQZGmho4w6';
      const hashIV = env.ECPAY_HASH_IV || 'EkRm7iFT261dpevs';

      const ecpayParams = {
        MerchantID: merchantId,
        MerchantTradeNo: tradeNo,
        MerchantTradeDate: tradeDate,
        PaymentType: 'aio',
        TotalAmount: amount,
        TradeDesc: 'MV9定位修改器',
        ItemName: `MV9定位修改器 x ${qty}`,
        ReturnURL: `${baseUrl}/api/ecpay/return`,
        ClientBackURL: `${baseUrl}/?tradeNo=${tradeNo}`,
        ChoosePayment: paymentMethod,
        EncryptType: 1
      };
      ecpayParams.CheckMacValue = await generateCheckMacValue(ecpayParams, hashKey, hashIV);

      const inputs = Object.entries(ecpayParams)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}" />`)
        .join('\n');

      return new Response(
        `<!DOCTYPE html><html><body>
          <form id="ecpayForm" method="POST" action="${aioUrl}">${inputs}</form>
          <script>document.getElementById('ecpayForm').submit();</script>
        </body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    // 2. 接收綠界 ReturnURL 付款通知
    if (request.method === 'POST' && url.pathname === '/api/ecpay/return') {
      const formData = await request.formData();
      const params = Object.fromEntries(formData.entries());

      const hashKey = env.ECPAY_HASH_KEY || 'pwFHCqoQZGmho4w6';
      const hashIV = env.ECPAY_HASH_IV || 'EkRm7iFT261dpevs';

      const valid = await verifyCheckMacValue(params, hashKey, hashIV);
      if (!valid) {
        return new Response('0|CheckMacValue Error', { status: 400 });
      }

      const tradeNo = params.MerchantTradeNo;
      const order = await getOrder(env, tradeNo);

      if (order && params.RtnCode === '1' && order.status !== 'PAID') {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();

        try {
          const invRes = await issueB2CInvoice(env, order);
          order.invoiceNo = invRes.InvoiceNo;
        } catch (err) {
          console.error('[Invoice Error]', err.message);
        }

        await saveOrder(env, tradeNo, order);
        ctx.waitUntil(sendOrderConfirmationEmail(env, order));
      }

      return new Response('1|OK', { headers: { 'Content-Type': 'text/plain' } });
    }

    // 3. 查詢訂單狀態
    if (request.method === 'GET' && url.pathname.startsWith('/api/orders/')) {
      const tradeNo = decodeURIComponent(url.pathname.replace('/api/orders/', ''));
      const order = await getOrder(env, tradeNo);
      if (!order) {
        return Response.json({ error: '查無此訂單' }, { status: 404 });
      }
      return Response.json(order);
    }

    // 4. 其餘請求交由 Cloudflare Static Assets 處理
    return env.ASSETS.fetch(request);
  }
};
