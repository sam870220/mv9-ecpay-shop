# 牛牛科技工作室 — MV9 定位修改器官網（綠界金流 + 自動開立電子發票 + 買方通知信）

## 功能特色
- **商品定價**：MV9 定位修改器 單台 NT$ 1,198。
- **買家表單**：收集姓名、電話、收件地址、Email 與電子發票開立方式（會員載具 / 手機條碼 / 公司統編 / 愛心碼）。
- **嚴格付款成立機制**：送出表單僅建立 `PENDING` 暫存單；唯有綠界科技 `ReturnURL` 通知 `RtnCode=1` 且 `CheckMacValue` 驗簽通過後，訂單才會轉為 `PAID`（正式成立）。
- **自動開發票與寄信**：訂單成立當下自動呼叫綠界 B2C 電子發票 API（`B2CInvoice/Issue`，AES-128-CBC 加密）開立發票，並透過 SMTP 寄送「訂單成立通知信」至買家信箱。

## 本機與雲端部署步驟
1. 安裝套件：
   ```bash
   npm install
   ```
2. 複製 `.env.example` 為 `.env` 並填入您的綠界金鑰與 SMTP 寄信帳號：
   ```bash
   cp .env.example .env
   ```
3. 啟動伺服器：
   ```bash
   npm start
   ```
4. 若部署於 Render / Zeabur / Railway，請將 `BASE_URL` 設為您的正式 `https://` 網址，綠界才可成功呼叫 `/api/ecpay/return`。
5. 官方測試信用卡號：`4311-9522-2222-2222`（安全碼任意三碼、有效期限任意未來月年、3D 驗證碼 `1234`）。
