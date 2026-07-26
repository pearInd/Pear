/* One-off: set the column G header to "IP". Run: node scripts/set-ip-header.js */
import "dotenv/config";
import { google } from "googleapis";

const email      = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const sheetId    = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
const sheetTab   = process.env.GOOGLE_SHEET_TAB || "TryOn Analytics";

const auth = new google.auth.GoogleAuth({
  credentials: { client_email: email, private_key: privateKey },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

await sheets.spreadsheets.values.update({
  spreadsheetId: sheetId,
  range: `${sheetTab}!G1`,
  valueInputOption: "USER_ENTERED",
  requestBody: { values: [["IP"]] },
});
console.log("✓ Set G1 = 'IP'");
