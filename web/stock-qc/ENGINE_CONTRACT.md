# Engine contract (read before writing a module)

The engine is plain JavaScript (no modules, no DOM). Each file is an IIFE that attaches to `globalThis.RRS`, loaded in
the order of `src/engine/order.json`. It runs in the browser, in Node tests (`node --test tests/*.test.mjs`) and later
in a Cloudflare Worker. Requirements of every phase come from `docs/PHASE0_STOCK_QC_AUDIT.md` and the Phase 0–6 plan
(acceptance criteria quoted in each section below). UI text and error messages are Thai.

## What already exists (do not edit these files – add what you need in your own module)

- `core.js` – `RRS.util` (ckey, normCode, round, num, trim, bkkDate, beDate, addDays, daysBetween, stable, sha256, sum),
  `RRS.schema.define(name, {label, phase, key, fields})`, `RRS.auth` (ROLES, PERMS, can, definePerm, rolesFor),
  `RRS.STATUS` (AVAILABLE, QC_HOLD, QUARANTINE, REWORK) + `RRS.STATUS_LABEL`, `RRS.TRANSIT`,
  `RRS.commands.define(kind, {label, perm, public?, prepare(tx, payload)})`, `RRS.hooks.on/run`,
  `RRS.core.prepare/reduce/createState`, `RRS.q` (rows, get, item, qty), `RRS.defaultSettings()`.
- `Tx` (the `tx` passed to prepare): `get(t,k)`, `all(t, filter)`, `put(t,k,row)`, `putRow(t,row)`, `del(t,k)`,
  `error(code, thaiMessage, {line?, field?})`, `warn(msg)`, `ok`, `can(perm, wh?)`, `need(perm, wh?)`,
  `different(userId, 'ผู้อนุมัติ')` (separation of duties), `settings()`, `nextNo(type, date)` → `PD6911-0001`,
  `nextId('RS')` → `RS-00001`, `item(code)` (by code / Express code / count code), `qty({code, wh, bin, status, lot})`,
  `balanceAt(loc)`, `move(loc, delta, {docType, docNo, line, job, remark, reversalOf, date}, {allowNegative})` –
  changes ONE balance and writes a movement; refuses to go below zero (error NEGATIVE). `tx.summary` (Thai one-liner
  for the audit log), `tx.result` (returned to the caller), `tx.now` (ISO), `tx.date` (Bangkok YYYY-MM-DD),
  `tx.userId`, `tx.user`. A command either succeeds whole or changes nothing: just call `tx.error` and return.
- `ledger.js` – `RRS.Ledger(store)` `.execute({kind, payload, requestId}, {user})`, `RRS.MemoryStore`.
- `master.js` (Phase 0) – tables `settings, users, warehouses, bins, items, item_units, boms, decisions, kpis`;
  `RRS.unitFactor(getter, item, unit)`; item fields: `id (=code), name, type RM|PART|SUB|FG|BUY|CONS, group, baseUnit,
  expressCode, countCode, model, side L|R|'', drawingNo, drawingRev, trackLot none|lot|heat|serial, certRequired,
  qcIncoming, qcFinal, material, thickness, width, length, minQty, maxQty, unitCost, active`. BOM row
  `{product, rev, status DRAFT|APPROVED|OBSOLETE, lines:[{code, qty (base unit per 1 product), unit}]}`.
- `inventory.js` (Phase 1) – table `documents`, `RRS.inventory`:
  - `DOC_TYPES` PD OU FR RR AJ RT TR; `defineType(code, {name, dir: -1|1|0|'T', express, perm?, outStatuses?, needsJob?, inStatus?(tx, doc, line, item)})`
  - `post(tx, docRow, {allowNegative})` – checks and posts a document row (`{type, date, job, ref, remark, lines:[{code, qty,
    unit, wh, bin, toWh, toBin, lot, status, reservationId, poNo, poLine, jobNo, remark}]}`), returns the stored row or null.
    Resolved line: `{line, code (item id), qty, unit, factor, base (base-unit qty, signed for AJ), wh, bin, lot, status, …}`.
  - hooks: `'doc.lineCheck'(tx, doc, line)`, `'doc.check'(tx, doc, lines)`, `'doc.posted'(tx, docRow, lines)`,
    `'doc.cancelled'(tx, docRow, lines)` – side effects of a document go here so they are in the same commit and are undone
    on cancel.
  - `reservedElsewhere(fn)` – fn(tx, code, wh, doc, line) → qty kept for other jobs (Phase 2 registers it).
  - `inboundStatus`: RR of `qcIncoming` items and FR of `qcFinal` items go to `QC_HOLD`; everything else `AVAILABLE`.
  - outgoing lines take `AVAILABLE` stock only unless the type lists more in `outStatuses`.
  - read helpers `locations, summary, history, verifyBalances`.
- Permissions: use the names already in `core.js` PERMS (`job.manage, production.record, reserve.manage, pick.post,
  express.import, express.reconcile, count.create, count.enter, count.approve, supplier.manage, pr.create, pr.approve,
  po.manage, po.receive, po.overReceive, po.close, qc.plan, qc.planApprove, qc.inspect, qc.release, qc.quarantine,
  ncr.disposition, ncr.useAsIs, lot.manage, offcut.manage, uat.record, backup.export, backup.restore`). Add a new one only
  with `RRS.auth.definePerm(name, roles, thaiLabel)` in your module.

## Rules for every module

- One file `src/engine/<module>.js` + one test file `tests/<phase>.test.mjs` (use `tests/helpers.mjs`: `world()`,
  `stockIn()`, users STORE1 STORE2 LEAD ACC PLAN PUR PURLEAD QC1 QCLEAD ENG PROD MGR VIEW, warehouses A (bins A-01, A-02),
  B (bin B-01), items TST-001, TST-002 (ชิ้น), TST-PLATE (heat-tracked, certRequired, qcIncoming), TST-FG (qcFinal)).
  Create the extra master data your tests need with commands (`item.upsert`, `bom.upsert`, `bom.approve` …).
- Tests use only core/master/inventory and YOUR module's commands. Other new modules are being written at the same
  time; read their tables by name (below) and treat a missing table as empty.
- Every table: `RRS.schema.define` with Thai labels (they become the data dictionary and the Google Sheet tabs).
- Expose read-only helpers for the screens on `RRS.<module>` (pure functions of a state).
- Never trust a quantity, code or name from input; resolve items with `tx.item`, check warehouses/bins exist.
- Never delete history; reversals point at what they reverse. Approvals record who and when. Same person may not
  approve their own request (`tx.different`).
- Keep commits small enough for one document (< 200 KB JSON).

## Shared tables (names and fields every module may read)

| table | key | fields |
| --- | --- | --- |
| `jobs` (P2) | jobNo | soNo, product, bomRev, qty (sets), dueDate, priority (1 highest … 5), status OPEN/IN_PROGRESS/DONE/DELIVERED/CANCELLED, lines:[{line, code, required, issued, toMake, finished, received, note}], createdBy, createdAt |
| `reservations` (P2) | id (RS-00001) | jobNo, code, wh, qty, issued, needDate, priority, status OPEN/PARTIAL/FILLED/RELEASED, createdBy/At, releasedBy/At, reason. remaining = qty − issued while OPEN/PARTIAL |
| `express_batches` (P3) | id (EX-00001) | fileName, fileHash, snapshotAt, importedBy/At, status REVIEW/CLOSED/DISCARDED, rows:[{row, rawCode, code, wh, qty, unit}], olderThanLatest |
| `count_sessions` (P3) | id (CT-00001) | wh, bins[], mode timestamp/freeze, status OPEN/SUBMITTED/APPROVED/CANCELLED, lines:[{code, bin, lot, status, system, counted, countedBy, countedAt, diff, recounts[], reason, flags[]}], createdBy, approvedBy/At, docNo |
| `suppliers` (P4) | id | name, taxId, contact, phone, leadDays, active |
| `item_suppliers` (P4) | code\|supplier | price, buyUnit, factor, moq, pack, leadDays, preferred |
| `prs` (P4) | prNo | date, status DRAFT/SUBMITTED/APPROVED/REJECTED/CONVERTED/CANCELLED, lines:[{line, code, qty, needDate, wh, supplier, reason}], requestedBy, approvedBy/At, poNos[] |
| `pos` (P4) | poNo | supplier, date, status DRAFT/ISSUED/PARTIAL/RECEIVED/CLOSED/CANCELLED, lines:[{line, code, qty, unit, factor, base, price, dueDate, wh, received, returned, cancelled, prNo}], issuedBy/At. outstanding = base − received − cancelled |
| `lots` (P5) | code\|lot | kind lot/heat/serial, supplier, poNo, docNo, receivedAt, cert {no, file, verified, verifiedBy, verifiedAt}, status ACTIVE/QUARANTINED |
| `qc_plans` (P5) | id (QP-00001) | code, stage INCOMING/IN_PROCESS/FINAL, drawingRev, sourceRef, sampling, chars:[{id, name, kind measure/check, nominal, min, max, unit, method}], status DRAFT/APPROVED/OBSOLETE, createdBy, approvedBy/At |
| `inspections` (P5) | id (IN-00001) | stage, code, wh, bin, lot, qty, fromStatus, sourceDoc, jobNo, planId, planRev, results:[{char, value, ok}], photos[], inspector, at, result PASS/FAIL, reinspectionOf, ncrNo, status OPEN/RELEASED/NCR, releasedBy/At |
| `ncrs` (P5) | ncrNo | code, wh, bin, lot, qty, inspectionId, jobNo, defect, description, status OPEN/DISPOSITIONED/CLOSED, disposition REWORK/RETURN/SCRAP/USE_AS_IS, dispositionBy/At, reason, conditions, docNo |
| `offcuts` (P6) | id (OC-00001) | code, material, thickness, width, length, wh, bin, sourceLot, status AVAILABLE/USED/SCRAPPED, parent, createdFrom, usedFor, by/at |
| `uat` (P6) | id | phase, criterion, status PASS/FAIL/NOT_RUN, tester, testedOn, evidence, note |
| `backup_tests` (P6) | id | at, by, commits, head, result OK/FAIL, note |

Document types added by later modules: `RV` คืนสินค้าผู้ขาย (P4, dir −1, outStatuses AVAILABLE/QUARANTINE/REWORK),
`SC` ตัดทิ้ง/ของเสีย (P5, dir −1, outStatuses AVAILABLE/QUARANTINE/REWORK), `DL` ส่งมอบลูกค้า (P5, dir −1, AVAILABLE only),
`QS` เปลี่ยนสถานะคุณภาพ (P5, written by the quality module with paired `tx.move` calls; never posted by hand).
None of these has a confirmed Express document type yet (`express: false`).
