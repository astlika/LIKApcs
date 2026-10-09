import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROLES, passwordSchema, usernameSchema } from '@likapcs/shared';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { getMigrationStatus, runMigrations } from './db/migrate.js';
import { UsersService } from './services/users.js';
import { SERVER_VERSION } from './version.js';

/**
 * likapcs-server CLI
 *   migrate          apply pending migrations
 *   migrate:status   show applied / pending migrations
 *   create-admin     interactively create an owner account (bootstrap or recovery)
 *   version          print the server version
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    console.info(
      `likapcs-server ${SERVER_VERSION}\n\nCommands:\n  migrate          Apply pending database migrations\n  migrate:status   Show migration status\n  create-admin     Create an owner account (first run or recovery)\n  version          Print version`,
    );
    return;
  }
  if (command === 'version') {
    console.info(SERVER_VERSION);
    return;
  }

  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: 2 });
  try {
    switch (command) {
      case 'migrate': {
        const result = await runMigrations(pool, config.migrationsDir, {
          info: (m) => console.info(`[migrate] ${m}`),
          error: (m) => console.error(`[migrate] ${m}`),
        });
        console.info(
          `Database is at schema version ${result.currentVersion} (${result.applied.length} applied now).`,
        );
        break;
      }
      case 'migrate:status': {
        const status = await getMigrationStatus(pool, config.migrationsDir);
        console.info(`Current schema version: ${status.currentVersion}`);
        for (const a of status.applied)
          console.info(
            `  applied  ${String(a.version).padStart(4, '0')}_${a.name}  (${a.appliedAt.toISOString()})`,
          );
        for (const p of status.pending) console.info(`  pending  ${p.fileName}`);
        if (status.pending.length === 0) console.info('  no pending migrations');
        break;
      }
      case 'create-admin': {
        const status = await getMigrationStatus(pool, config.migrationsDir);
        if (status.pending.length)
          throw new Error('Run "migrate" before creating an administrator.');
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          const fullName = (await rl.question('Full name: ')).trim();
          const username = usernameSchema.parse(await rl.question('Username: '));
          const password = passwordSchema.parse(
            await rl.question('Password (min 8 chars, letters + digits): '),
          );
          const users = new UsersService(pool);
          const user = await users.create(
            {
              username,
              fullName,
              password,
              roles: [ROLES.OWNER],
              mustChangePassword: false,
              email: null,
              phone: null,
            },
            { userId: null, roles: null, label: 'cli' },
          );
          console.info(`Owner account "${user.username}" created (id ${user.id}).`);
        } finally {
          rl.close();
        }
        break;
      }
      default:
        throw new Error(`Unknown command "${command}". Run with --help.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
