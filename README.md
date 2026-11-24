# 牛牛科技工作室 MV9 定位修改器 — Cloudflare Workers 部署指南

此版本專為 **Cloudflare Workers** 打造，使用原生的 Web Crypto API 實作綠界 AIO CheckMacValue 與 B2C 電子發票 AES-128-CBC 加密，**零外部套件相依、不會休眠、部署只需十幾秒**！

## 快速部署步驟（Cloudflare Dashboard + GitHub）
1. 將本資料夾內容上傳至 GitHub 儲存庫。
2. 進入 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Compute (Workers) → Workers & Pages → Create → Import a repository**，選擇該 GitHub 儲存庫。
3. **Build command** 留空（或填 `npx wrangler deploy` 視介面設定，預設 Deploy command 為 `npx wrangler deploy`）。
4. 部署完成取得 `https://mv9-ecpay-shop.xxx.workers.dev` 網址後，到 Worker 的 **Settings → Variables and Secrets** 新增：
   - `BASE_URL` = 您的 `workers.dev` 網址
   - `ECPAY_ENV` = `stage`（測試）或 `prod`（正式）
   - `ECPAY_MERCHANT_ID`、`ECPAY_HASH_KEY`、`ECPAY_HASH_IV`
   - `ECPAY_INV_MERCHANT_ID`、`ECPAY_INV_HASH_KEY`、`ECPAY_INV_HASH_IV`
   - （選填寄信）`RESEND_API_KEY`（至 [Resend](https://resend.com/) 免費註冊取得）與 `MAIL_FROM`
5. （建議）到 **Storage & Databases → KV** 建立一個名為 `ORDERS_KV` 的 Namespace，並在 Worker 的 **Settings → Bindings** 綁定變數名稱 `ORDERS_KV`，訂單紀錄即可永久保存！
