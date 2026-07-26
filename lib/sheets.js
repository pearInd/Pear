/* =============================================================================
   Google Sheets analytics - server-side only
   Sheet structure:
     Row 1 header:  Garment | S | M | L | XL | ... | SUM
     Row 2+:        <garment name> | <count> | ... | =SUM(B?:E?)
   - If garment row exists: increments the matching size cell.
   - If garment is new: appends a row with 0s, 1 for the triggered size,
     and a SUM formula in the last column.
   ============================================================================= */
import { google } from "googleapis";

let _sheetsClient = null;

function resolveCredentials() {
  const email      = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (email && privateKey) {
    console.log("[sheets] auth: using GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY");
    return { client_email: email, private_key: privateKey };
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    console.log("[sheets] auth: using GOOGLE_SERVICE_ACCOUNT_JSON");
    try { return JSON.parse(raw); } catch (e) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: " + e.message);
    }
  }

  throw new Error(
    "No Google credentials found. Set either:\n" +
    "  GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY\n" +
    "  or GOOGLE_SERVICE_ACCOUNT_JSON"
  );
}

function resolveSheetId() {
  const id = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
  if (!id) throw new Error("No sheet ID found. Set GOOGLE_SHEET_ID in Vercel env vars.");
  return id;
}

async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const credentials = resolveCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  _sheetsClient = google.sheets({ version: "v4", auth });
  console.log("[sheets] client ready");
  return _sheetsClient;
}

// Convert 0-based column index to A1 letter notation (0→A, 25→Z, 26→AA …)
function colLetter(index) {
  let letter = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

export async function logTryOn({ garmentName, size }) {
  const sheetId  = resolveSheetId();
  const sheetTab = process.env.GOOGLE_SHEET_TAB || "TryOn Analytics";
  const sheets   = await getSheetsClient();

  // Read the full sheet
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: sheetTab,
  });
  const rows = readRes.data.values ?? [];
  if (rows.length === 0) throw new Error("[sheets] Sheet is empty - add header row first.");

  const headerRow = rows[0]; // ["Garment", "S", "M", "L", "XL", "SUM"]

  // Identify the SUM column (last column in header)
  const sumColIndex = headerRow.length - 1;

  // Size columns: everything between col 0 (Garment) and sumColIndex (SUM)
  const sizeColIndex = headerRow.findIndex(
    (h, i) => i > 0 && i < sumColIndex &&
               h.trim().toUpperCase() === String(size).trim().toUpperCase()
  );
  if (sizeColIndex === -1) {
    throw new Error(`[sheets] Size "${size}" not found in header: ${headerRow.join(", ")}`);
  }

  // Search column A for the garment (rows[1] onward)
  const garmentRowIndex = rows.findIndex(
    (row, i) => i > 0 && row[0]?.trim().toLowerCase() === String(garmentName).trim().toLowerCase()
  );

  if (garmentRowIndex !== -1) {
    // --- Garment exists: increment the size cell ---
    const currentValue = parseInt(rows[garmentRowIndex]?.[sizeColIndex] ?? "0", 10) || 0;
    const newValue     = currentValue + 1;
    const cellAddress  = `${sheetTab}!${colLetter(sizeColIndex)}${garmentRowIndex + 1}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: cellAddress,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newValue]] },
    });

    console.log(`[sheets] ✓ updated ${garmentName} / ${size}: ${currentValue} → ${newValue} (${cellAddress})`);
  } else {
    // --- New garment: append a full row ---
    const newRowNumber = rows.length + 1; // 1-based sheet row for the appended row

    // Build the row: garment name, then 0 for each size col (except triggered size = 1), then SUM formula
    const sizeCount = sumColIndex - 1; // number of size columns
    const sizeCells = Array.from({ length: sizeCount }, (_, i) =>
      i === sizeColIndex - 1 ? 1 : 0
    );

    // SUM range covers columns B through the col before SUM
    const sumRange = `${colLetter(1)}${newRowNumber}:${colLetter(sumColIndex - 1)}${newRowNumber}`;
    const newRow   = [garmentName, ...sizeCells, `=SUM(${sumRange})`];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetTab}!A:A`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });

    console.log(`[sheets] ✓ new garment "${garmentName}" appended - ${size} set to 1 (row ${newRowNumber})`);
  }
}

/* =============================================================================
   Admin session logs - a SHARED, PERSISTENT store on a dedicated sheet tab.
   Every try-on session (anonymized id + measurements + garment) is appended as
   one row. Because the data lives in Google Sheets - not in server memory - it
   survives Vercel cold starts/redeploys and is the SAME for every admin who logs
   in (you and your friend both read the identical rows).

   Tab layout (auto-created on first write if missing):
     Timestamp | Session ID | Height | Weight | Chest | Waist | Legs | Size | Garment ID | Garment Name
   ============================================================================= */
const SESSION_TAB    = process.env.GOOGLE_SESSIONS_TAB || "Sessions";
const SESSION_HEADER = [
  "Timestamp", "Session ID", "Height", "Weight", "Chest",
  "Waist", "Legs", "Size", "Garment ID", "Garment Name",
];

// Make sure the Sessions tab exists and carries a header row. Creating the tab
// on demand means the operator never has to set the sheet up by hand.
async function ensureSessionTab(sheets, sheetId) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === SESSION_TAB);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SESSION_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SESSION_TAB}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [SESSION_HEADER] },
    });
    console.log(`[sheets] created "${SESSION_TAB}" tab + header`);
    return;
  }

  // Tab exists - guarantee the header row is present.
  const head = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SESSION_TAB}!1:1`,
  });
  if (!head.data.values || head.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SESSION_TAB}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [SESSION_HEADER] },
    });
  }
}

/** Append ONE try-on session row. Missing measurements are stored as "". */
export async function appendSessionLog({
  sessionId, height, weight, chest, waist, legs, size, garmentId, garmentName,
}) {
  const sheetId = resolveSheetId();
  const sheets  = await getSheetsClient();
  await ensureSessionTab(sheets, sheetId);

  const cell = (v) => (v === null || v === undefined || v === "" ? "" : v);
  const row  = [
    new Date().toISOString(),
    cell(sessionId), cell(height), cell(weight), cell(chest),
    cell(waist), cell(legs), cell(size), cell(garmentId), cell(garmentName),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${SESSION_TAB}!A:A`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  console.log(`[sheets] ✓ session row appended (${sessionId} · ${garmentName || "-"})`);
}

/** Read every session row back as objects, newest first. */
export async function readSessionLogs() {
  const sheetId = resolveSheetId();
  const sheets  = await getSheetsClient();
  await ensureSessionTab(sheets, sheetId);

  const res  = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: SESSION_TAB,
  });
  const rows = res.data.values ?? [];
  if (rows.length <= 1) return [];   // header only

  return rows
    .slice(1) // drop header
    .map((r) => ({
      ts:          r[0] ?? "",
      sessionId:   r[1] ?? "",
      height:      r[2] ?? "",
      weight:      r[3] ?? "",
      chest:       r[4] ?? "",
      waist:       r[5] ?? "",
      legs:        r[6] ?? "",
      size:        r[7] ?? "",
      garmentId:   r[8] ?? "",
      garmentName: r[9] ?? "",
    }))
    .reverse(); // newest first
}
