# RRS Stock & QC – เซิร์ฟเวอร์ (Cloudflare Worker)

เอกสารนี้อธิบายเซิร์ฟเวอร์ของระบบสต็อกและ QC ที่อยู่ในโฟลเดอร์ `web/stock-qc/worker/` แบบออกแบบละเอียดอยู่ที่ `../BACKEND_DESIGN.md`
และกติกาของ engine อยู่ที่ `../ENGINE_CONTRACT.md`

> **สถานะ:** ยังไม่เคย deploy ขึ้นที่ใดเลย ทุกอย่างที่บอกว่า "ผ่าน" ในเอกสารนี้ทดสอบใน Miniflare/workerd บนเครื่อง และใช้ server ปลอมที่รันในเครื่องเท่านั้น
> ค่าเริ่มต้นเป็นแบบ staging ทุกตัว: ตัวเชื่อม Sales Office ปิด (`SQ_SALES_BRIDGE=off`), สำรองไป Google Drive ปิด (`SQ_DRIVE_BACKUP_ENABLED=false`)
> และระบบไม่ส่งข้อความหรือคำขอออกไปภายนอกเองเลย

## 1. เซิร์ฟเวอร์นี้ทำอะไร

- เป็น Cloudflare Worker ตัวเดียว ใช้ **D1** (ฐานข้อมูล SQL, binding `DB`) **R2** (เก็บไฟล์, binding `BUCKET`) และ **Assets** (หน้าเว็บจาก `../dist`, binding `ASSETS`)
- รัน engine ชุดเดียวกับหน้าเว็บ (`../src/engine/*.js` ตามลำดับใน `order.json`) Worker เป็นผู้เขียนข้อมูลเพียงรายเดียว:
  ทุกคำสั่งจากหน้าเว็บผ่าน `RRS.core.prepare` ได้ผลเป็น commit เดียวที่ต่อ hash เป็นสายโซ่ แล้วบันทึกลง D1 แบบ atomic
- `sq_commits` คือข้อมูลจริง (append-only มี trigger ห้าม UPDATE/DELETE) ส่วน `sq_records` เป็นสำเนาอ่านเร็วที่เขียนใน batch เดียวกับ commit
  และสร้างใหม่ได้เสมอจาก `sq_commits`
- ไม่ใช้ไฟล์ข้อมูลตัวอย่าง: `fixture.js` และ `selftest.js` ไม่ถูก import ฝั่งเซิร์ฟเวอร์ (`scripts/sync-engine.mjs`)

## 2. บันทึกข้อมูลแบบเดียวกับ Sales Office อย่างไร

| เรื่อง | Sales Office (อ่านอย่างเดียว) | ในเซิร์ฟเวอร์นี้ |
| --- | --- | --- |
| เข้าสู่ระบบ | `lib/rrs/auth.ts`: เจ้าของจาก `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` (bcrypt), session id = HMAC(token), cookie `__Host-`, rate limit 10 ครั้ง/IP และ 100 ครั้งรวมต่อ 15 นาที, ข้อความผิดพลาดเดียวกันทุกกรณี, audit ทุกครั้ง | `src/auth.js` แบบเดียวกัน (bcryptjs 3.0.3) บัญชีอื่นอยู่ใน `sq_app_users` บทบาท/คลังอยู่ในตาราง `users` ของ engine (`accountId` = ชื่อบัญชี) |
| คำขอจากเว็บอื่น | `requireSameOrigin` ใน `lib/rrs/security.ts` | `src/security.js` ทุก POST ต้องมี `Origin` ตรงกับเว็บนี้ และไม่ใช่ `Sec-Fetch-Site: cross-site` |
| บันทึกแบบกันชนกัน | `commit()` ใน `lib/rrs/server.ts`: CAS ด้วย revision/token ของ workspace ใน `db().batch` เดียว | `src/ledger.js`: INSERT commit ได้เฉพาะเมื่อ `MAX(seq) = seq-1` และ `prev` = hash ที่เก็บไว้ พร้อมเขียน `sq_records` ใน batch เดียวกัน แพ้การชนกัน = อ่านใหม่แล้ว prepare ใหม่ (สูงสุด 5 ครั้ง) requestId เดิม = ทำครั้งเดียว |
| ตารางอ่านเร็ว | `rrs_records(workspace,id,kind,data)` | `sq_records(tbl,id,data,seq)` ตรวจ/ซ่อมได้ด้วย `POST /api/admin/records` |
| สำรองไป Google Drive | `lib/integrations/google-drive-backup.ts`, `lib/rrs/drive-backup.ts`, `lib/rrs/drive-oauth.ts` | `src/backup.js`: refresh token → access token, โฟลเดอร์ต้องเป็นส่วนตัวและตรวจซ้ำก่อนเขียนทุกไฟล์, จอง file id ก่อนอัปโหลด (ส่งซ้ำไม่เกิดไฟล์ซ้ำ), อ่านกลับมาเทียบขนาดและ `sha256Checksum`, manifest เขียนเป็นไฟล์สุดท้าย |
| ตัวเชื่อม Part List | branch `codex/rrs-workflow-partlist-20261027` (commit `81163c4`) `lib/rrs/partlist-bridge.ts`, `partlist-store.ts`, `operations-schema.ts` | `src/sales-bridge.js` เป็นฝั่ง client ของ protocol เดียวกัน (GET/POST `/api/rrs/partlist/bridge?mode=domestic|export`) และคำสั่ง engine `sales.syncJob`/`sales.mapJob` ใน `../src/engine/sales.js` |
| สวิตช์เปิดงานจริง | `RRS_PARTLIST_ENABLED === 'true'` (ตรงตัวอักษรเท่านั้น) | `SQ_DRIVE_BACKUP_ENABLED` ต้องเป็น `true` ตรงตัว, `SQ_SALES_BRIDGE` ต้องเป็น `pull` หรือ `pull_push` ตรงตัว อย่างอื่นถือว่าปิด |

สิ่งที่ยัง **ไม่เหมือน** Sales Office: ยังไม่มี MFA (Sales Office มี TOTP) บัญชีเจ้าของจึงต้องใช้รหัสผ่านที่แข็งแรง และไม่มีระบบบทบาทในชั้นเข้าสู่ระบบ
(สิทธิ์ทั้งหมดมาจากตาราง `users` ของ engine)

## 3. ไฟล์

```
wrangler.toml               ชื่อ rrs-stock-qc, D1 DB, R2 BUCKET, assets ../dist (run_worker_first = true), cron, vars ปิดทั้งหมด
                            database_id / bucket name เป็นค่าตัวอย่างสำหรับเครื่องเท่านั้น ไม่ใช่ของจริง
migrations/0001_init.sql    ตารางหลัก (append-only: ห้ามแก้ไฟล์ที่ใช้ไปแล้ว)
migrations/0002_integrations.sql  ตารางของ backup และตัวเชื่อม
src/index.js                เส้นทาง API, cron, หน้าเว็บ
src/runtime.js              env, HttpError, header ความปลอดภัย, log แบบตัดค่าที่หน้าตาเหมือน token
src/security.js             sha256/hmac/token, เทียบค่าแบบเวลาคงที่, จำกัดขนาด body, same-origin, rate limit, security event
src/auth.js                 เข้าสู่ระบบ/ออก/session/เปลี่ยนรหัส/บัญชี
src/ledger.js               ledger ฝั่งเซิร์ฟเวอร์ (cache ใน isolate + CAS ใน D1 + snapshot ใน R2 + ตรวจ/ซ่อม sq_records)
src/files.js                อัปโหลด/ดาวน์โหลดไฟล์ใน R2
src/backup.js               สำรอง commit ไป Google Drive (ปิดเป็นค่าเริ่มต้น)
src/sales-bridge.js         ตัวเชื่อม Sales Office (ปิดเป็นค่าเริ่มต้น)
src/outbound.js             fetch ที่มี timeout, จำกัดขนาดคำตอบ, ไม่ตาม redirect
src/engine-imports.js       สร้างจาก ../src/engine/order.json ด้วย `npm run sync-engine` (ห้ามแก้เอง)
scripts/hash-password.mjs   สร้าง bcrypt hash (cost 12) ของรหัสเจ้าของจาก stdin
scripts/build-site.mjs      สร้าง ../dist สำหรับโหมดเซิร์ฟเวอร์ (RRS_API=/api)
test/*.test.mjs             ทดสอบใน Miniflare (ไม่ต้องมีบัญชี Cloudflare) + server ปลอมของ Google และ Sales Office
.dev.vars.example           ชื่อตัวแปรเท่านั้น (ไม่มีค่า)
```

## 4. API

| เส้นทาง | ใครใช้ได้ | ผล |
| --- | --- | --- |
| `POST /api/auth/login {username, password}` | ทุกคน (rate limit) | cookie `__Host-sq_session` (HttpOnly; Secure; SameSite=Lax; Path=/; 8 ชม.) |
| `POST /api/auth/logout` | – | ปิด session และล้าง cookie |
| `GET /api/auth/session` | มี session | ชื่อบัญชี, owner, mustChange, ผู้ใช้ใน engine |
| `POST /api/auth/password {current, next}` | มี session (ไม่ใช่เจ้าของ) | เปลี่ยนรหัส ปิดทุก session ของบัญชีนั้น |
| `POST /api/admin/credentials {username, password?, active?}` | เจ้าของ หรือสิทธิ์ `users.manage` | สร้างบัญชี/ตั้งรหัสชั่วคราว/เปิด-ปิดบัญชี |
| `POST /api/admin/records {repair?}` | เจ้าของ หรือสิทธิ์ `backup.restore` | ตรวจ `sq_records` เทียบกับการเล่นซ้ำ `sq_commits` ทั้งหมด (ตรวจ hash) `repair: true` = ซ่อมแถวที่ไม่ตรง |
| `POST /api/command {kind, payload, requestId}` | ผู้ใช้ใน engine ที่ผูกกับบัญชี (คำสั่ง public เช่น `user.requestAccess` ใช้ได้โดยไม่ต้องมีผู้ใช้ใน engine, 10 ครั้ง/ชม.) | ผลของ engine (หนึ่ง commit) |
| `GET /api/commits?after=N` | เจ้าของ หรือผู้ใช้ใน engine ที่ใช้งานอยู่ | ≤ 500 commit / ≈ 4 MB ต่อหน้า |
| `POST /api/files`, `GET /api/files/<sha256>` | ผู้ใช้ใน engine (ดูอย่างเดียว = ดาวน์โหลดได้อย่างเดียว) | ≤ 10 MB, JPG/PNG/WEBP/PDF/CSV/XLSX ตรวจ magic bytes |
| `POST /api/backup/run`, `GET /api/backup/status` | เจ้าของ หรือ `backup.export` | สำรองหนึ่งรอบ / สถานะ (ไม่มีค่า secret) |
| `POST /api/sales/sync {workspace?}`, `GET /api/sales/status` | เจ้าของ หรือ `job.manage` / ผู้ใช้ทุกคน | ซิงก์หนึ่งรอบ / สถานะตัวเชื่อม (ไม่มีค่า secret) |
| `GET /api/health` | ทุกคน | บอกว่าตั้งค่าอะไรแล้ว (true/false) ไม่บอกค่า |

ทุกคำตอบของ `/api` มี `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, CSP `default-src 'none'; frame-ancestors 'none'; sandbox`,
`X-Frame-Options: DENY` และ HSTS ทุก POST ต้องมาจากเว็บเดียวกัน ข้อมูล via/user/เวลา ที่ client ส่งมาถูกละทิ้งเสมอ (เซิร์ฟเวอร์รู้ว่าใครจาก session)

## 5. รันในเครื่อง

ต้องใช้ Node ≥ 22.13 ทุกคำสั่งรันในโฟลเดอร์ `web/stock-qc/worker`

```sh
npm ci                                  # ติดตั้งตาม package-lock.json (bcryptjs 3.0.3, wrangler 4.92.0, miniflare 4.20260515.0)
cp .dev.vars.example .dev.vars          # .dev.vars ถูก git ignore – ใส่ค่าทดลองที่ทิ้งได้เท่านั้น
node scripts/hash-password.mjs          # พิมพ์รหัสเจ้าของ (ไม่แสดงบนจอ) ได้ hash ไปใส่ ADMIN_PASSWORD_HASH ใน .dev.vars
#   SESSION_SECRET: อย่างน้อย 32 ตัว เช่น `openssl rand -hex 32`
npx wrangler d1 migrations apply DB --local   # สร้างตารางใน D1 ของเครื่องก่อนเสมอ
npm run build:site                      # สร้าง ../dist สำหรับโหมดเซิร์ฟเวอร์ (RRS_API=/api) – เขียนทับ ../dist
npx wrangler dev                        # เปิด http://localhost:8787
npm test                                # ชุดทดสอบทั้งหมดใน Miniflare
```

หมายเหตุ:
- `npm run build:site` เขียนทับ `../dist` ซึ่งหน้าเว็บโหมดอื่นใช้ร่วมกัน ให้รันเมื่อพร้อมเท่านั้น
- cookie `__Host-` ต้องมี `Secure` เบราว์เซอร์ส่วนใหญ่ยอมให้ใช้กับ `http://localhost` แต่ยังไม่ได้ทดสอบกับเบราว์เซอร์จริงในขั้นนี้
- `.dev.vars` ห้ามใส่ค่า production ห้ามชี้ `SQ_SALES_URL` ไป Sales Office ตัวจริง และห้ามใส่ token Google ของบัญชีจริง
- ตั้ง `ADMIN_PASSWORD_HASH` ด้วย cost 12 (ค่าที่ script สร้าง) เวลาตอบของการเข้าสู่ระบบจะเท่ากันทุกบัญชี ถ้าใช้ cost สูงกว่า
  ชื่อบัญชีเจ้าของจะดูออกได้จากเวลาที่ตอบ (บัญชีอื่นไม่ได้รับผลกระทบ)
- `ADMIN_USERNAME` ใช้ได้ A-Z a-z 0-9 . _ @ - ยาว 3–100 ตัว ห้ามมี `:` ช่องว่าง หรือเป็นชื่อสงวน (`__proto__`, `constructor` ฯลฯ)
  และอย่าใช้ชื่อเดียวกับบัญชีที่มีอยู่แล้วใน `sq_app_users`

## 6. Migration

- ไฟล์ใน `migrations/` เป็นแบบ append-only: ไฟล์ที่ apply แล้วห้ามแก้ การเปลี่ยนแปลงใหม่ให้เพิ่มไฟล์ `0003_….sql` ต่อท้าย
  ห้าม DROP/RESET/seed ฐานข้อมูลจริง
- ลำดับ: `npx wrangler d1 migrations apply DB --local` ก่อนเสมอ แล้วรัน `npm test` ให้ผ่าน
  จากนั้นจึง `--remote` กับ D1 ของ staging เท่านั้น และต้องได้รับอนุมัติจากเจ้าของก่อน
- `database_id` ใน `wrangler.toml` เป็นค่าตัวอย่าง (`00000000-…`) ให้ใส่ id จริงของ staging ใน checkout ที่ใช้ deploy เท่านั้น ห้าม commit

## 7. Secret ที่ต้องตั้ง (ชื่อเท่านั้น)

ตั้งด้วย `npx wrangler secret put NAME` ในบัญชี Cloudflare ของ staging:

- เข้าสู่ระบบ: `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (`node scripts/hash-password.mjs | npx wrangler secret put ADMIN_PASSWORD_HASH`), `SESSION_SECRET`
- Google Drive: `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `SQ_DRIVE_BACKUP_FOLDER_ID`; เชื่อม OAuth ผ่านหน้า Nexus เพื่อเก็บ refresh token แบบเข้ารหัสใน D1 หรือใช้ `GOOGLE_DRIVE_REFRESH_TOKEN` ที่ตั้งไว้ล่วงหน้า (scope `https://www.googleapis.com/auth/drive` เพื่อเข้าถึงโฟลเดอร์เดิมและตรวจสิทธิ์ปลายทาง)
  (โฟลเดอร์ส่วนตัวของ staging ไม่แชร์ ไม่อยู่ใน shared drive)
- Sales Office: `SQ_SALES_URL` (https origin ของ Sales Office **staging** ไม่มี path), `SQ_SALES_CONNECTOR_ID`,
  `SQ_SALES_DOMESTIC_SECRET`, `SQ_SALES_EXPORT_SECRET` (แต่ละตัว ≥ 32 ตัวอักษร และสองตัวต้องไม่ซ้ำกัน – Domestic กับ Export แยกกันเสมอ)

ค่าทั่วไปอยู่ใน `[vars]` ของ `wrangler.toml`: `SQ_ENV`, `SQ_SALES_BRIDGE` (`off`), `SQ_DRIVE_BACKUP_ENABLED` (`false`), `SQ_SNAPSHOT_EVERY` (500)

## 8. ขั้นตอนขึ้น staging (ทุกขั้นต้องได้รับอนุมัติจากเจ้าของ ยังไม่ได้ทำ)

1. สร้าง D1 และ R2 ของ staging ในบัญชี Cloudflare ของบริษัท ใส่ id ใน checkout สำหรับ deploy เท่านั้น
2. `npx wrangler d1 migrations apply DB --remote`
3. ตั้ง secret ชุดเข้าสู่ระบบ (ข้อ 7) ยังไม่ต้องตั้ง Google/Sales Office
4. `npm run build:site` แล้ว `npx wrangler deploy` – ต้องใช้ Workers paid plan (bcrypt cost 12 แบบ JS ใช้ CPU ราว 200–400 ms ต่อการเข้าสู่ระบบ)
5. ตรวจ `GET /api/health`: `login: true`, `database: ready`, ตัวเชื่อม `mode: off`, backup `enabled: false`
6. เจ้าของเข้าสู่ระบบ สั่ง "เริ่มระบบ" (`system.bootstrap`) สร้างบัญชีพนักงาน (`/api/admin/credentials`) และผูกผู้ใช้ใน engine
7. ทดสอบสำรองข้อมูล: ตั้ง secret Google ของโฟลเดอร์ staging แล้วเปลี่ยน `SQ_DRIVE_BACKUP_ENABLED = "true"` ทีละสวิตช์ สั่ง `POST /api/backup/run`
   แล้วตรวจไฟล์และ manifest ด้วยหน้า "สำรองและกู้คืน" (`RRS.reports.verifyBackup`)
8. ตัวเชื่อม: ตั้ง secret ของ Sales Office **staging** แล้ว `SQ_SALES_BRIDGE = "pull"` ก่อน (อ่านอย่างเดียว ไม่ POST)
   ตรวจ `GET /api/sales/status` ทั้งสองพื้นที่ จากนั้นจึงพิจารณา `pull_push` ตามกฎข้อ 9
9. ห้ามตัดเข้าระบบจริง (production cutover) จนกว่าจะมีเป้าหมาย, แผนสำรอง/กู้คืนที่ทดสอบแล้ว และการอนุมัติชัดเจน

## 9. กฎหนึ่งตัวเชื่อมต่อหนึ่งพื้นที่ (ข้อตกลง ค-10)

Sales Office รับตัวเชื่อม Part List ได้ **ตัวเดียวต่อพื้นที่** (Domestic หนึ่งตัว, Export หนึ่งตัว) ตัวเชื่อมของโปรแกรม ST01 บนเครื่อง
(branch `codex/so-partlist-bridge-20261027`) ใช้ bridge เดียวกัน

- เปิด `pull_push` ใน stock-qc ได้ **เฉพาะเมื่อปิดตัวเชื่อมของ ST01 สำหรับพื้นที่นั้นแล้ว** ถ้าเปิดพร้อมกัน Sales Office จะตอบ `mapping_conflict`
  (externalJobId ไม่ตรงกัน)
- `pull` อ่านอย่างเดียว ไม่เคย POST จึงใช้คู่กับตัวเชื่อมอื่นได้
- Domestic และ Export ใช้ secret แยกกัน ทุกแถวเก็บ `workspace` ไว้ ใบงานจาก SO มีคีย์ที่รวมชื่อพื้นที่ และไม่จับคู่ลูกค้าด้วยชื่อเด็ดขาด
  (ไม่เก็บชื่อลูกค้าหรือเจ้าของ SO เก็บเฉพาะรหัสจาก Sales Office)

## 10. ย้อนกลับ (rollback)

1. ปิดสวิตช์ก่อน: `SQ_SALES_BRIDGE = "off"` และ `SQ_DRIVE_BACKUP_ENABLED = "false"` แล้ว deploy ใหม่ (cron จะไม่ส่งคำขอใดอีก)
2. ถ้าโค้ดใหม่มีปัญหา ให้ย้อน Worker ไปเวอร์ชันก่อนหน้า (`npx wrangler rollback`) โดยไม่แตะข้อมูล
3. **เก็บ D1 และ R2 ไว้เสมอ** ห้าม drop/reset/ลบตาราง หรือลบ snapshot/ไฟล์ใน R2
4. **ห้ามกู้ backup เก่าทับข้อมูลที่ใหม่กว่า** การกู้คืนทำในระบบทดสอบที่แยกต่างหากเท่านั้น ระบบจริงต่อยอดจาก commit ล่าสุดเสมอ
   (ถ้าข้อมูลตัวเชื่อม `sq_bridge_events` ถอยกลับ หมายเลข `sourceVersion` จะต่ำกว่าที่ Sales Office เคยรับ แล้วโดนตอบ `stale_status` จนกว่าจะเลยค่าเดิม)
5. ถ้า `sq_records` ไม่ตรงกับ commit ให้ใช้ `POST /api/admin/records` ตรวจก่อน แล้วค่อยสั่ง `{"repair": true}` (ซ่อมจากการเล่นซ้ำ commit ที่ตรวจ hash แล้ว)
6. ถ้า commit ใน D1 ไม่ตรงลายนิ้วมือ ระบบจะหยุดรับคำสั่ง (`LEDGER_INTEGRITY`) และบันทึก security event ระดับ critical – ห้ามแก้ D1 ด้วยมือ ให้แจ้งผู้ดูแล

## 11. ผลการตรวจความปลอดภัย (ขั้นที่ 3)

ปัญหาที่พบ เขียนเทสต์ที่ล้มก่อน แล้วแก้ (`test/review.test.mjs`):

1. **เดาชื่อบัญชีจากเวลาตอบ** – ชื่อที่ไม่มีหรือบัญชีที่ปิดอยู่ถูกเทียบกับ `ADMIN_PASSWORD_HASH` (ยอม cost 12–16) ส่วนบัญชีจริงเทียบกับ hash cost 12
  ของตัวเอง ด้วย hash เจ้าของ cost 14 ชื่อที่ไม่มีตอบช้ากว่า 3.9 เท่า → ตอนนี้ใช้ hash หลอก cost เดียวกับบัญชี (`src/auth.js`)
2. **ชื่อบัญชีที่เป็นชื่อของ Object.prototype** (`__proto__`, `constructor`, `toString` …) สร้างได้ ชื่อบัญชีกลายเป็นคีย์ของตาราง
  `access_requests` และ `__proto__` ทำให้ prototype ของตารางใน state เปลี่ยน (isolate ที่รันอยู่กับ snapshot/การเล่นซ้ำเห็นข้อมูลไม่เท่ากัน)
  → ห้ามชื่อเหล่านี้ทั้งตอนสร้างบัญชีและตอนเข้าสู่ระบบ และ ledger ไม่รับ commit ที่มีคีย์แบบนี้ (`BAD_KEY`)
3. **`ADMIN_USERNAME` ไม่ถูกตรวจ** – เช่น `sales-bridge:domestic` (namespace ของตัวเชื่อม) หรือ `__proto__` → ตอนนี้ถือว่ายังตั้งค่าไม่ครบ (503)
4. **คำสั่ง public ของ engine ใช้ไม่ได้** – `user.requestAccess` (ปุ่ม "ขอใช้งานระบบ") ได้ 403 เสมอ → บัญชีที่ยังไม่มีผู้ใช้ใน engine
  ส่งได้ในนามบัญชีของตัวเองเท่านั้น (by ว่าง, via = ชื่อบัญชีจาก session) จำกัด 10 ครั้งต่อชั่วโมง คำสั่งอื่นยัง 403 `NO_USER`
5. **ข้อความผิดพลาดของ engine เปิดเผยโค้ด** – เช่น `(p.roles || []).filter is not a function` → ตอบเป็นภาษาไทยทั่วไป (รหัส `INTERNAL`)
  รายละเอียดลง log ของ Worker แบบตัดค่าที่หน้าตาเหมือน token
6. **หน้าเว็บจองรหัสคำขอของตัวเชื่อมได้** – requestId `so.<พื้นที่>.…` ของ Sales Office ถูกใช้ก่อนได้ ทำให้คำสั่งนั้นได้ `REQUEST_REUSED`
  ตลอดไป → สงวน prefix `so.` ไว้ให้งานของเซิร์ฟเวอร์ และไม่รับ requestId ที่เป็นชื่อของ Object.prototype
7. **ไฟล์ artifact หลุดออกทาง `/artifact`** – `run_worker_first` เดิมเป็นรายการ path แต่ html_handling ของ Cloudflare เสิร์ฟ
  `artifact.html` (หน้าเว็บโหมดเก็บในเบราว์เซอร์) ที่ `/artifact` จาก asset store โดยไม่ผ่าน Worker และไม่มี header กันการฝังหน้า
  → `run_worker_first = true` และ Worker ตอบ HTML ได้เฉพาะ `/` ไฟล์ static ทุกไฟล์ได้ header ของ Worker
8. **ชื่อไฟล์ใน Content-Disposition** – `'` `(` `)` ไม่ถูกเข้ารหัสตาม RFC 8187 → เข้ารหัสแล้ว
9. **ตรวจ/สร้าง `sq_records` ใหม่ไม่ได้** – เอกสารบอกว่า "สร้างใหม่ได้" แต่ไม่มีโค้ด → `POST /api/admin/records` เล่นซ้ำ commit ทั้งหมด
  (ตรวจ hash และสายโซ่) เทียบทุกแถวและ seq แล้วซ่อมแบบมีเงื่อนไขว่า head ยังเป็นค่าเดิม (มี commit ใหม่ระหว่างซ่อม = หยุด `CHANGED`)

ตรวจแล้วไม่พบปัญหา (มีเทสต์กันถอยหลัง): rate limit หลบด้วย `X-Forwarded-For`/`X-Real-IP`/`True-Client-IP` ไม่ได้ (ใช้ `CF-Connecting-IP`
อย่างเดียว), session fixation (token ใหม่ทุกครั้ง cookie เดิมถูกปิด, cookie ชื่อซ้ำสองตัว = ไม่มี session), batch ของ commit + records
เป็น transaction เดียว (records เขียนไม่ได้ = ไม่มี commit, ส่ง requestId เดิมซ้ำแล้วได้ครั้งเดียว), SQL ทุกคำสั่ง bind ค่า (ที่ต่อ string มีแต่ชื่อคอลัมน์คงที่),
log ไม่มีค่าที่เหมือน token
เรื่องที่เทสต์ของขั้นก่อนครอบคลุมอยู่แล้ว: cookie flags, เปลี่ยนรหัสแล้วปิดทุก session, same-origin ทุก POST, สิทธิ์ `users.manage`,
CAS ข้าม isolate, snapshot ถูกแก้ = ใช้ตัวก่อนหน้า, commit ถูกแก้ = หยุด, ชนิด/ขนาดไฟล์, health ไม่มีค่า secret,
Domestic/Export แยก secret และข้อมูล, คำสั่งซ้ำ/ฉบับเก่า/stale event, lease และการล้มกลางทางของ backup

## 12. ทดสอบอะไรแล้ว และยังไม่ได้ทดสอบอะไร

ทดสอบแล้ว (ทั้งหมดบนเครื่อง ไม่มีบัญชี Cloudflare/Google/Sales Office):
- `npm test` = 65 เทสต์ผ่านทั้งหมด (auth 10, ledger 9, cold-start 3, files 7, routes 4, backup 8, sales-bridge 10, review 14)
  รันสองแบบ: bundle ของ esbuild ใน test helper และ bundle ที่ `wrangler deploy --dry-run` สร้าง (`SQ_WORKER_BUNDLE`) ใน network namespace
  ที่มีแค่ loopback (ไม่มีทางออกเน็ต)
- `node --test tests/sales.test.mjs` ของ engine = 10/10 และ engine ทั้งชุด (`node --test tests/*.test.mjs` ใน `web/stock-qc`)
  = 200 ผ่าน 1 ข้าม (DL ทดสอบที่โมดูลที่นิยาม) 0 ล้ม ณ เวลาที่รัน (โมดูลอื่นยังมีคนแก้อยู่)
- `wrangler deploy --dry-run` (wrangler 4.92.0, offline): config ผ่าน (`run_worker_first = true`, binding DB/BUCKET/ASSETS, vars ปิดทั้งหมด)
- `wrangler d1 migrations apply DB --local` (offline): 0001 + 0002 ใช้ได้
- เทสต์ routing ของ asset ใช้ค่าจาก `wrangler.toml` จริง แปลงแบบที่ wrangler แปลง และใช้ router ของ Miniflare (html_handling `auto-trailing-slash`)

ยังไม่ได้ทดสอบ:
- Cloudflare จริง: D1/R2/Workers ที่ deploy แล้ว, `migrations apply --remote`, cron ที่ยิงจริง, ขีดจำกัด CPU/หน่วยความจำ/เวลา
  (SQL ที่ใช้ `json_each`, `->`, row-value, trigger รันใน Miniflare/workerd เท่านั้น)
- asset router ของ Cloudflare จริง (ทดสอบกับ router ของ Miniflare ซึ่งเป็นโค้ดชุดเดียวกับที่ wrangler ใช้ในเครื่อง)
- Google OAuth/Drive จริง และ Sales Office จริง (ใช้ server ปลอมที่เขียนตามโค้ดของ Sales Office branch `81163c4` ไม่ได้ใช้ zod)
- เบราว์เซอร์จริง: cookie `__Host-` ผ่าน `wrangler dev`, หน้าเข้าสู่ระบบ/เริ่มระบบ/อัปโหลด และปุ่ม "ขอใช้งานระบบ"
  (หน้าเว็บยังเรียก `/api/commits` ก่อนแสดงหน้าขอใช้งาน บัญชีที่ยังไม่มีผู้ใช้ใน engine จึงยังเห็นข้อผิดพลาด – เป็นงานของฝั่ง UI)
- เทสต์เวลาเข้าสู่ระบบเทียบค่ากลางของ 3 ครั้ง (เกณฑ์ 0.55–1.8 เท่า) บนเครื่องที่ทำงานหนักมากอาจแกว่งได้
- `POST /api/admin/records` กับ ledger ขนาดใหญ่ (เล่นซ้ำทุก commit ใน request เดียว) และ snapshot ทุก 500 commit (เทสต์ใช้ 1 และ 5)
- rate limit ข้ามช่วง 15 นาที และขีดรวม 100 ครั้ง (ทดสอบเฉพาะต่อ IP)
- `scripts/build-site.mjs` (ไม่ได้รัน เพราะเขียนทับ `../dist` ที่งานอื่นใช้)

## 13. เรื่องที่ยังเปิดอยู่

- ยังไม่มี MFA
- state ทั้งหมดอยู่ในหน่วยความจำของ isolate และใน snapshot: ใช้ได้กับ pilot แต่ต้องแบ่ง/เก็บถาวรเมื่อข้อมูลโตมาก
- สำรองข้อมูลด้วยมือรันใน request เดียว ledger ใหญ่อาจชนขีดเวลา/CPU; รอบตามเวลาที่ล้มไม่ลองใหม่ในวันเดียวกัน; ถ้ารอบด้วยมือกำลังรันตอน 03:00 รอบตามเวลาของวันนั้นจะถูกข้าม
- event ที่ Sales Office ปฏิเสธด้วยเหตุถาวร (`stale_status`, `unknown_job` …) จะไม่ส่งซ้ำจนกว่าสถานะงานจะเปลี่ยน
- engine (`master.js`, ไม่ใช่ไฟล์ของเซิร์ฟเวอร์): `tx.get(table, 'constructor')` ได้ฟังก์ชัน `Object` แทน null และ `user.upsert`
  รับ `accountId` อะไรก็ได้ – ฝั่งเซิร์ฟเวอร์กันไว้แล้ว (ชื่อบัญชีสงวน + `BAD_KEY`) แต่ควรแก้ใน engine ด้วย
- เจ้าของล็อกตัวเองได้: ถ้าผู้ดูแลผูกผู้ใช้ใน engine ของเจ้าของไปที่บัญชีอื่น เจ้าของยังเข้าสู่ระบบ อ่านข้อมูล และจัดการบัญชีได้ แต่สั่งงานไม่ได้จนกว่าจะผูกใหม่

## 14. Native Google Sheets รายวัน

เปิด `SQ_DRIVE_BACKUP_ENABLED=true` และ `SQ_SHEETS_EXPORT_ENABLED=true` หลังเชื่อม Google และตั้งโฟลเดอร์ส่วนตัวแล้ว
ต้องเปิด Drive API และ Sheets API ใน Google Cloud project ของ OAuth client ด้วย รอบประจำวันคือ `0 20 * * *` UTC
ตรงกับ **03:00 Asia/Bangkok** โค้ดและ `wrangler.toml` ต้องตั้งตรงกัน; ให้ตรวจ cron ที่ deploy จริงด้วย

แต่ละรอบสร้างโฟลเดอร์ลงวันที่ มี JSONL สำหรับกู้คืน, Google Sheets แบบ native หนึ่งไฟล์ และ `manifest.json` เป็นไฟล์สุดท้าย
Google Sheets มีแท็บสินค้า คลัง ช่องเก็บ หน่วย BOM ยอดสต็อก เอกสารและรายการย่อย ใบงาน จองสินค้า ผู้ขาย PR/PO
ล็อต แผน QC ผลตรวจ NCR ตรวจนับ กระทบยอด เศษวัสดุ และประวัติทำรายการ ทุกแท็บอ้างอิง head เดียวกับ JSONL แม้มีรายการใหม่ระหว่างส่งออก
ชีตเป็นภาพข้อมูล ณ เวลานั้น การแก้ในชีตไม่เปลี่ยนข้อมูลใน Nexus; ข้อมูลสำหรับกู้คืนยังใช้ JSONL ตาม manifest

ค่าทุกช่องส่งเป็นข้อความด้วย `valueInputOption=RAW` เพื่อคงเลขศูนย์นำหน้าและไม่ประมวลผลสูตร ตรวจค่าที่ API ตอบกลับทุกชุด
ไม่ส่งตารางบัญชีเข้าสู่ระบบ รหัสผ่าน เซสชัน หรือ secrets; เนื้อหาไฟล์แนบ R2 ไม่รวมอยู่ในชีต
จำกัดข้อมูล 1,000,000 ช่อง / 32 MB, 45,000 ตัวอักษรต่อช่อง และคำขอไม่เกิน 1 MB; เกินขนาดจะล้มเหลวอย่างชัดเจน ไม่ตัดข้อมูลเงียบ ๆ

Google ไม่รองรับ Drive pre-generated IDs สำหรับไฟล์ Google Sheets จึงสร้างเพียงครั้งเดียวด้วยชื่อ `INCOMPLETE - ...`
เมื่อเขียนและตรวจครบแล้วจึงเปลี่ยนชื่อเป็นชื่อจริง คำขอเขียนค่าเดิมซ้ำได้และลองใหม่สูงสุด 3 ครั้งเมื่อ 429/5xx หรือเครือข่ายไม่แน่นอน
หากยืนยันผลสร้างไฟล์ไม่ได้จะหยุดโดยไม่สร้างไฟล์ซ้ำ รอบล้มเหลวไม่มี manifest ที่สมบูรณ์และไฟล์ที่ทราบ ID จะถูกทำเครื่องหมาย `FAILED`
(ถ้า Worker หยุดทันทีหรือไฟล์ถูกแชร์ระหว่างรอบ ชื่ออาจคง `INCOMPLETE` และสถานะรอบจะหมด lease เป็น failed)
เมื่อรันด้วยมือสำเร็จ API ส่ง `run.spreadsheet.url` และ manifest เก็บ ID/URL/จำนวนแถวแต่ละแท็บ; ประวัติเดิมยังเปิดผ่านลิงก์โฟลเดอร์

ทดสอบเฉพาะส่วนนี้ด้วย `node --test test/backup.test.mjs test/sheets-export.test.mjs` ใน worker: JSONL/restore เดิม,
RAW/ขนาดชุด/ข้อมูลลับ, retry ที่เขียนสำเร็จแต่ตอบผิดพลาด, การสร้าง native file ที่ผลไม่แน่นอน, การแชร์ระหว่างรอบ,
ข้อมูลตอบกลับไม่ตรง, และรายการใหม่ที่เข้าระหว่างส่งออก ใช้ Google จำลอง ไม่ยืนยันการทำงานของ Google/Cloudflare จริง
