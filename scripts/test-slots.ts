import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Machine-wide limit on memory-heavy test runs. A server test file (several
 * in-memory PGlite companies) or an e2e run (web build, server and Chrome)
 * each peaks at roughly 1.5–2 GB. Several worktrees running tests at once used
 * to exceed the memory cap and get processes OOM-killed, so every such run
 * first takes one of SHMI_TEST_SLOTS slots (default 2; 0 = no limit) and waits
 * while all are taken. Slots are files in the system temp directory, shared by
 * every checkout on the machine; a slot whose owner died is reclaimed.
 */

const DIR = path.join(tmpdir(), 'shmi-test-slots');
const HEARTBEAT_MS = 30_000;
/** A slot not refreshed for this long is stale even if its pid exists (pid reuse). */
const STALE_MS = 5 * 60_000;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryTake(file: string, label: string) {
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // Taken: reclaim it when its owner is gone or stopped refreshing it. The check and
  // the removal run under a lock directory, so two processes cannot both reclaim the
  // same stale slot (the second would delete the first one's fresh slot).
  if (!withReclaimLock(() => {
    try {
      const { pid } = JSON.parse(readFileSync(file, 'utf8')) as { pid: number };
      if (alive(pid) && Date.now() - statSync(file).mtimeMs <= STALE_MS) return false;
      unlinkSync(file);
      return true;
    } catch (e) {
      // Removed meanwhile: free now. Half-written: try again on the next round.
      return (e as NodeJS.ErrnoException).code === 'ENOENT';
    }
  })) return false;
  return tryTake(file, label);
}

/** Runs fn while holding DIR/reclaim.lock (mkdir is atomic); false when the lock is busy. */
function withReclaimLock(fn: () => boolean): boolean {
  const lock = path.join(DIR, 'reclaim.lock');
  try {
    mkdirSync(lock);
  } catch {
    // Busy; a lock left by a process that died inside the section is removed after 10 s.
    try {
      if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
    } catch {
      // Released meanwhile.
    }
    return false;
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

/** Waits for a free slot; returns the function that frees it (also freed on exit). */
export async function acquireTestSlot(label: string): Promise<() => void> {
  const slots = Number(process.env.SHMI_TEST_SLOTS ?? 2);
  if (!(slots > 0)) return () => {};
  mkdirSync(DIR, { recursive: true });
  let warned = false;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const file = path.join(DIR, `slot-${i}`);
      if (!tryTake(file, label)) continue;
      const beat = setInterval(() => {
        try {
          utimesSync(file, new Date(), new Date());
        } catch {
          // Removed by release or by hand.
        }
      }, HEARTBEAT_MS);
      beat.unref();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        process.off('exit', release);
        try {
          const { pid } = JSON.parse(readFileSync(file, 'utf8')) as { pid: number };
          if (pid === process.pid) unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
      process.on('exit', release);
      return release;
    }
    if (!warned) {
      warned = true;
      process.stderr.write(`[test-slots] ${label}: waiting for a free test slot (${slots} in use, see ${DIR})\n`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
