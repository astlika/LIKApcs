/**
 * "End Task" (0.17.0): closing the games / launchers on a gaming PC from the desk.
 *
 * The scope is deliberately narrow: the client only ever closes programs from the list the owner
 * keeps in Settings › Stations (`stations.end_tasks_exes`) — never "everything that is open",
 * never the LIKApcs-Client itself or the Windows shell. The same rules live in three places,
 * each a defence of its own: this module (Admin input + server settings validation + the client
 * agent), and a hard-coded copy inside the Rust side of the client, which is what finally calls
 * `taskkill`.
 */

/** Processes no list may ever contain: LIKApcs itself, its WebView, and the Windows shell. */
export const PROTECTED_PROCESSES: ReadonlySet<string> = new Set([
  'likapcs-client.exe',
  'likapcs.exe',
  'msedgewebview2.exe',
  'explorer.exe',
  'csrss.exe',
  'winlogon.exe',
  'wininit.exe',
  'services.exe',
  'lsass.exe',
  'smss.exe',
  'svchost.exe',
  'dwm.exe',
  'system',
  'fontdrvhost.exe',
  'sihost.exe',
  'taskhostw.exe',
  'ctfmon.exe',
  'conhost.exe',
  'runtimebroker.exe',
  'audiodg.exe',
  'spoolsv.exe',
  'searchhost.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
  'textinputhost.exe',
  'securityhealthservice.exe',
  'msmpeng.exe',
  'taskmgr.exe',
  'cmd.exe',
  'powershell.exe',
]);

/** Common games and launchers offered as one-click chips in Settings. */
export const END_TASKS_SUGGESTIONS: readonly string[] = [
  'steam.exe',
  'steamwebhelper.exe',
  'EpicGamesLauncher.exe',
  'Battle.net.exe',
  'RiotClientServices.exe',
  'LeagueClient.exe',
  'VALORANT-Win64-Shipping.exe',
  'cs2.exe',
  'FortniteClient-Win64-Shipping.exe',
  'GTA5.exe',
  'FiveM.exe',
  'RobloxPlayerBeta.exe',
  'javaw.exe',
  'Minecraft.Windows.exe',
  'RocketLeague.exe',
  'r5apex.exe',
  'Discord.exe',
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
];

export const MAX_END_TASKS = 60;
/**
 * A bare Windows executable name: letters, digits, dot, space, dash, underscore, brackets,
 * apostrophe, plus — and it must end in `.exe`. Shell metacharacters are excluded so the name
 * can never be mistaken for something else when the client builds `taskkill /IM <name>`.
 */
const EXE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+'-]{0,62}\.exe$/;

/**
 * Normalises what the owner typed into a bare `name.exe` (path stripped, `.exe` appended when
 * missing). Returns `null` for anything that is not a plausible Windows executable name.
 */
export function normalizeExeName(input: string): string | null {
  let name = input.trim().replace(/^["']|["']$/g, '');
  const slash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
  if (slash >= 0) name = name.slice(slash + 1);
  if (!name) return null;
  if (!/\.exe$/i.test(name)) {
    // `steam.exe -t` is a command line, not a program name: never append around it.
    if (/\.exe/i.test(name)) return null;
    name = `${name}.exe`;
  }
  name = name.replace(/\.EXE$/, '.exe');
  return EXE_NAME.test(name) ? name : null;
}

export function isProtectedProcess(name: string): boolean {
  return PROTECTED_PROCESSES.has(name.trim().toLowerCase());
}

/**
 * Validates a whole list the way the server does: every entry a plausible exe name, none
 * protected, no duplicates (case-insensitive). Returns the cleaned list or the first problem.
 */
export function validateEndTasks(
  list: readonly string[],
): { ok: true; exes: string[] } | { ok: false; error: string; entry: string } {
  const seen = new Set<string>();
  const exes: string[] = [];
  for (const raw of list) {
    const name = normalizeExeName(raw);
    if (!name) return { ok: false, error: 'invalid_exe', entry: raw };
    if (isProtectedProcess(name)) return { ok: false, error: 'protected', entry: name };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    exes.push(name);
  }
  if (exes.length > MAX_END_TASKS)
    return { ok: false, error: 'too_many', entry: String(exes.length) };
  return { ok: true, exes };
}
