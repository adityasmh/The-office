// Import this FIRST in any check script that must not touch the real company/ folder.
// ES module imports are evaluated in order, so this runs before org.ts captures COMPANY_ROOT.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "company-sandbox-"));
process.env.COMPANY_ROOT = sandboxRoot;