import { loadConfig } from '../config/env.js';
import { openDatabase, pruneExpiredData } from './database.js';

/** Applies migrations and the retention policy, then exits. */
function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const pruned = pruneExpiredData(db, Date.now(), {
    searchSession: config.searchRetentionDays,
    searchResult: config.searchRetentionDays,
  });
  db.close();
  process.stdout.write(
    JSON.stringify({
      message: 'Database ready',
      path: config.databasePath,
      pruned: pruned.filter((entry) => entry.deleted > 0),
    }) + '\n',
  );
}

main();
