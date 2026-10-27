// User management from the shell, e.g. when the only admin forgot their password:
//   docker exec -it stremio-music sm-user list
//   docker exec -it stremio-music sm-user add alice [--admin]
//   docker exec -it stremio-music sm-user passwd alice
//   docker exec -it stremio-music sm-user admin alice on|off
//   docker exec -it stremio-music sm-user disable|enable|delete alice
// Passwords are prompted for (no echo), or read from stdin when it isn't a terminal.
import readline from 'node:readline';
import { AuthStore } from './auth/store.js';
import { passwordProblem, USERNAME_RE } from './auth/password.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.on('data', (c) => (data += c));
      process.stdin.on('end', () => resolve(data.split('\n')[0]!.replace(/\r$/, '')));
    });
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    let muted = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (!muted) write(s);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function newPassword(): Promise<string> {
  const p1 = await readPassword('New password: ');
  const problem = passwordProblem(p1);
  if (problem) throw new Error(problem);
  if (process.stdin.isTTY && (await readPassword('Repeat password: ')) !== p1) throw new Error("Passwords don't match.");
  return p1;
}

const usage = `usage: sm-user list | add <name> [--admin] | passwd <name> | admin <name> on|off | disable <name> | enable <name> | delete <name>`;

async function main(argv: string[]): Promise<void> {
  const [cmd, name, arg] = argv;
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const store = new AuthStore(db, config.auth.sessionTtlMs);
  const user = () => {
    const u = name ? store.findUser(name) : null;
    if (!u) throw new Error(`no such user: ${name ?? '(missing)'}`);
    return u;
  };
  try {
    switch (cmd) {
      case 'list':
        for (const u of store.listUsers()) {
          console.log(`${u.username}${u.isAdmin ? '  admin' : ''}${u.disabled ? '  disabled' : ''}${u.hasPassword ? '' : '  (proxy user)'}`);
        }
        return;
      case 'add': {
        if (!name || !USERNAME_RE.test(name)) throw new Error('invalid username (letters, digits, . _ @ -)');
        if (store.findUser(name)) throw new Error('that username is taken');
        const pw = config.auth.mode === 'local' ? await newPassword() : null;
        await store.createUser(name, pw, argv.includes('--admin'));
        console.log(`added ${name}`);
        return;
      }
      case 'passwd':
        await store.setPassword(user().id, await newPassword());
        console.log(`password changed for ${name}; their sessions were signed out`);
        return;
      case 'admin': {
        if (arg !== 'on' && arg !== 'off') throw new Error(usage);
        const u = user();
        if (arg === 'off' && u.isAdmin && store.countActiveAdmins() <= 1) throw new Error('there must be at least one admin');
        store.updateUser(u.id, { isAdmin: arg === 'on' });
        console.log(`${name}: admin ${arg}`);
        return;
      }
      case 'disable':
      case 'enable': {
        const u = user();
        if (cmd === 'disable' && u.isAdmin && store.countActiveAdmins() <= 1) throw new Error('there must be at least one admin');
        store.updateUser(u.id, { disabled: cmd === 'disable' });
        console.log(`${name}: ${cmd}d`);
        return;
      }
      case 'delete': {
        const u = user();
        if (u.isAdmin && !u.disabled && store.countActiveAdmins() <= 1) throw new Error('there must be at least one admin');
        store.deleteUser(u.id);
        console.log(`deleted ${name}`);
        return;
      }
      default:
        throw new Error(usage);
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
