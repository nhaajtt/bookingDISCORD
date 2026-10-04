import { backupDb } from "../backup.js";
import { config } from "../config.js";
import { DAY } from "../domain/time.js";

export default {
  name: "backup",
  everyMs: DAY,
  // An in-memory database (tests) has nothing to copy
  run: () => (config.dataDir === ":memory:" ? null : backupDb()),
};
