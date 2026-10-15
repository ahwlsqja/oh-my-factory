import { loadAudit, recordAudit } from "../../src/audit/work-audit.js";
import type { WorkAudit } from "../../src/audit/work-audit.js";
import { Ledger } from "../../src/core/ledger.js";
import { SCOPE } from "./audit-diff-fixture.js";
import { makeTempDir } from "./tmp.js";

/** Records `report` through a real ledger and reads it back the way GATE-3 must: through the ledger-checked `loadAudit`. */
export function recordAndLoad(report: WorkAudit) {
  const itemDir = makeTempDir("omf-item-");
  const ledger = new Ledger(makeTempDir("omf-ledger-"));
  recordAudit(ledger, SCOPE, itemDir, report);
  const events = ledger.readVerified();
  return {
    itemDir,
    ledger,
    events,
    payload: events.at(-1)?.payload ?? {},
    loaded: loadAudit(itemDir, SCOPE.run_id, events),
  };
}
