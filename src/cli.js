#!/usr/bin/env node
'use strict';
/**
 * ZCode account seamless switching CLI
 *
 * (Windows console defaults to GBK, Node outputs UTF-8 which causes garbled text.
 *  Here we switch stdout/stderr to UTF-8 at process startup to ensure Chinese characters display correctly.) */
try {
  if (process.stdout.isTTY && typeof process.stdout.handle?.setEncoding === 'function') {
    process.stdout.handle.setEncoding('utf8');
  }
} catch (_) {}
// Force UTF-8 encoding for decode/write
try { process.stdout.setDefaultEncoding('utf8'); } catch (_) {}
try { process.stderr.setDefaultEncoding('utf8'); } catch (_) {}

/**
 * ZCode account seamless switching CLI
 *
 * Usage:
 *   node src/cli.js status                          Show current account + saved account list
 *   node src/cli.js capture [--name label] [--note note]   Save current ZCode login state as account snapshot
 *   node src/cli.js list                            List all saved accounts
 *   node src/cli.js use <id|index> [--no-restart] [--force]   Switch to specified account (auto-restart ZCode by default)
 *   node src/cli.js delete <id|index>                Delete account snapshot
 *   node src/cli.js rename <id|index> <new-name>       Rename account
 *   node src/cli.js rollback                        Rollback to login state before switching
 *
 * Note: <id|index> can be either account short ID (e.g. a86931xx) or index from list (1,2,3...)
 */
const manager = require('./manager');
const switcher = require('./switcher');
const quota = require('./quota');
const { findZCodeExe, CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');

function parseArgs(argv) {
  const out = { _: [], flags: {}, kv: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags[key] = true;
      } else {
        out.kv[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Both index and id can be resolved */
function resolveId(input) {
  if (!input) throw new Error('Please provide an account id or index');
  const list = manager.list();
  if (list.length === 0) throw new Error('No saved accounts');
  // Pure digits → index
  if (/^\d+$/.test(input)) {
    const idx = parseInt(input, 10);
    if (idx < 1 || idx > list.length) throw new Error(`Index out of range (1~${list.length})`);
    return list[idx - 1].id;
  }
  // Otherwise treat as id (supports prefix matching)
  const exact = list.find((x) => x.id === input);
  if (exact) return exact.id;
  const pref = list.filter((x) => x.id.startsWith(input));
  if (pref.length === 1) return pref[0].id;
  if (pref.length > 1) throw new Error('ID prefix matches multiple accounts; please provide a more specific ID');
  throw new Error('Account not found: ' + input);
}

function printTable(list) {
  if (list.length === 0) {
    console.log('  (No saved accounts. Use `capture` to add one)');
    return;
  }
  console.log('');
  console.log('  #     id          name                 provider                 captured at          size');
  console.log('  ----  ----------  -------------------  -----------------------  ------------------  ----');
  list.forEach((a, i) => {
    const no = String(i + 1).padStart(4);
    const id = (a.id || '').padEnd(10).slice(0, 10);
    const label = (a.label || '').padEnd(19).slice(0, 19);
    const prov = (a.provider || '').padEnd(23).slice(0, 23);
    const dt = fmtDate(a.capturedAt).padEnd(18);
    const sz = (a.sizeKb || 0) + 'KB';
    console.log(`  ${no}  ${id}  ${label}  ${prov}  ${dt}  ${sz}`);
  });
  console.log('');
}

function fmtQuota(value) {
  if (value == null) return 'unknown';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function printQuota(q) {
  console.log('=== ZCode Quota ===');
  console.log('Total:   ' + fmtQuota(q.total));
  console.log('Used:    ' + fmtQuota(q.used));
  console.log('Remain:  ' + fmtQuota(q.remaining));
  console.log('Usage:   ' + (q.percentUsed == null ? 'unknown' : q.percentUsed.toFixed(1) + '%'));
  if (q.refreshedAt) console.log('Updated: ' + fmtDate(q.refreshedAt));
  if (q.items && q.items.length) {
    console.log('');
    console.log('▶ Model breakdown:');
    q.items.forEach((item) => {
      console.log(`  - ${item.name}: remaining ${fmtQuota(item.remaining)} / total ${fmtQuota(item.total)} (${item.unit || 'quota'})`);
    });
  }
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const args = parseArgs(process.argv.slice(3));

async function main() {
  switch (cmd) {
    case 'status': {
      const cur = manager.current();
      console.log('=== ZCode Account Switcher ===');
      console.log('ZCode client: ' + (findZCodeExe() || 'not found'));
      console.log('Running:       ' + (switcher.isZCodeRunning() ? '✅ running' : '⛔ not running'));
      console.log('Credentials:   ' + require('path').dirname(CREDENTIALS_FILE));
      if (cur) {
        console.log('');
        console.log('▶ Current account:');
        console.log('  Fingerprint: ' + cur.shortId + (cur.userId ? '  (user_id=' + cur.userId + ')' : ''));
        console.log('  Source:      ' + cur.source);
        console.log('  Provider: ' + cur.provider);
      } else {
        console.log('\n⚠ Cannot identify current account (not signed in, or credentials are encrypted)');
      }
      console.log('');
      console.log('▶ Saved account snapshots:');
      printTable(manager.list());
      return;
    }

    case 'list': {
      printTable(manager.list());
      return;
    }

    case 'quota': {
      const q = await quota.getQuotaOverview();
      printQuota(q);
      return;
    }

    case 'capture': {
      const r = manager.capture({
        label: args.kv.name,
        note: args.kv.note || '',
        overwrite: !!args.flags.overwrite,
      });
      if (r.created) {
        console.log('✅ Captured: ' + r.meta.label + '  (id=' + r.meta.id + ')');
      } else if (r.skipped) {
        console.log('ℹ ' + r.message + '. Use --overwrite to replace.');
      }
      return;
    }

    case 'use': {
      const id = resolveId(args._[0]);
      const meta = JSON.parse(require('fs').readFileSync(manager.metaPath(id), 'utf8'));
      console.log('🔄 Switching to: ' + meta.label + '  (id=' + id + ')');
      const opts = {
        restart: !args.flags['no-restart'],
        force: args.flags.force !== false, // default force
      };
      const r = await manager.use(id, opts);
      console.log('✅ Login state switched.');
      if (r.restarted) console.log('🚀 ZCode restarted. Changes are active.');
      else console.log('ℹ ZCode was not restarted (--no-restart or launch failed). Start it manually.');
      return;
    }

    case 'delete':
    case 'remove': {
      const id = resolveId(args._[0]);
      const ok = manager.remove(id);
      console.log(ok ? '🗑 Deleted: ' + id : '⚠ Account not found: ' + id);
      return;
    }

    case 'rename': {
      const id = resolveId(args._[0]);
      const newName = args._[1];
      if (!newName) throw new Error('Please provide a new name');
      const m = manager.rename(id, newName);
      console.log('✏ Renamed to: ' + m.label);
      return;
    }

    case 'rollback': {
      const r = await switcher.rollback({
        restart: !args.flags['no-restart'],
        force: args.flags.force !== false,
      });
      console.log('↩ Rolled back to previous login state.');
      if (r.restarted) console.log('🚀 ZCode restarted.');
      return;
    }

    case 'kill': {
      const running = switcher.isZCodeRunning();
      if (!running) { console.log('ZCode is not running.'); return; }
      console.log('Shutting down ZCode...');
      const ok = await switcher.killZCode();
      console.log(ok ? '✅ Closed.' : '⚠ Shutdown timed out.');
      return;
    }

    case 'launch': {
      try { switcher.launchZCode(); console.log('🚀 ZCode launched.'); }
      catch (e) { console.error('❌ ' + e.message); process.exit(1); }
      return;
    }

    default:
      console.log('ZCode Account Switcher\n');
      console.log('Usage:');
      console.log('  status                          Show current account + saved list');
      console.log('  capture [--name label]           Save current login state as snapshot');
      console.log('  list                            List all accounts');
      console.log('  quota                           Check current account quota');
      console.log('  use <id|index> [--no-restart]   Switch account (auto-restarts ZCode)');
      console.log('  delete <id|index>               Delete account');
      console.log('  rename <id|index> <new-name>    Rename account');
      console.log('  rollback                        Rollback to previous login state');
      console.log('  kill / launch                   Stop / start ZCode manually');
  }
}

main().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
