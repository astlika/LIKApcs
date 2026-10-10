export type Language = 'en' | 'sq';

const en = {
  station: 'Station',
  locked: 'This PC is locked',
  lockedHint: 'Please ask the staff to start your session.',
  free: 'Free play',
  remaining: 'Time left',
  elapsed: 'Time played',
  paused: 'Paused',
  connected: 'Connected',
  connecting: 'Connecting to the server…',
  offline: 'Connection lost — reconnecting…',
  offlineSession: 'Connection lost — your timer continues.',
  noServer: 'Looking for the LIKApcs server on the network…',
  noServerHint: 'Make sure the main PC is on and LIKApcs is running there.',
  registering: 'Waiting for approval',
  registeringHint:
    'Staff: open LIKApcs Admin → Stations → “Devices awaiting approval” and assign this PC to a station.',
  computer: 'Computer name',
  machineId: 'Machine ID',
  server: 'Server',
  rejected: 'This PC was rejected by the staff.',
  rejectedHint:
    'It will ask again in a few minutes. Staff can approve it in LIKApcs Admin → Stations.',
  needsReissue: 'This PC was approved before, but its credentials are missing.',
  needsReissueHint:
    'Staff: LIKApcs Admin → Stations → this device → “Re-issue token”. The PC reconnects by itself.',
  incompatible: 'This client is not compatible with the server.',
  incompatibleHint:
    'An update is being installed. If this message stays, update the client from the main PC.',
  updating: 'Installing update…',
  version: 'Version',
  settingsTitle: 'LIKApcs Client settings',
  serverAddress: 'Server address',
  serverAddressHint:
    'Normally found automatically. Only set it when the server is on another network segment.',
  save: 'Save',
  close: 'Close',
  findServer: 'Find on network',
  foundNone: 'No server found.',
  pairedNote:
    'This PC is paired. To move it to another server or station, revoke the device in LIKApcs Admin → Stations; it will register again automatically.',
  language: 'Language',
  maintenance: 'Maintenance',
  maintenanceBy: 'Unlocked by',
  locksIn: 'Locks in',
  lockNow: 'Lock',
  staffUnlockTitle: 'Staff unlock',
  staffUnlockHint:
    'Unlock this PC for maintenance with your own LIKApcs username and password. No session is started and nothing is billed; the PC locks again automatically.',
  username: 'Username',
  password: 'Password',
  unlock: 'Unlock',
  cancel: 'Cancel',
  unlocking: 'Checking with the server…',
  unlockedUntil: 'Unlocked until',
  errInvalidCredentials: 'Wrong username or password.',
  errNoPermission: 'This account may not unlock station PCs.',
  errLocked: 'Account temporarily locked after too many attempts.',
  errSessionActive: 'A customer session is running on this PC.',
  errNotConnected: 'The PC is not connected to the server yet — try again in a moment.',
  errRateLimited: 'Too many attempts — wait a minute.',
  errGeneric: 'The server refused the request.',
  errNetwork: 'The server could not be reached.',
  // ─── pairing / connection ───
  noServerManual:
    'Or type the server address shown in LIKApcs Admin → Gaming Stations → “Connect a PC”:',
  serverAddressPlaceholder: 'e.g. 192.168.1.10 or 192.168.1.10:4700',
  connect: 'Connect',
  connecting2: 'Checking…',
  discoveryHint:
    'Found “{name}” on the network, but it does not accept connections at {url}. On the main PC open LIKApcs Admin → Gaming Stations → “Connect a PC” and press “Allow now” (Windows Firewall).',
  registeringHint2:
    'Staff: on the main PC open LIKApcs Admin → Gaming Stations → “Connect a PC”, find this computer in the list and assign it to a station. The PC continues by itself.',
  connectedTo: 'Connected to “{name}” (server {version}). Registering this PC…',
  errAddressInvalid: 'That is not a valid address. Example: 192.168.1.10',
  errAddressTimeout:
    'No answer from {url}. Check that the main PC is on, both PCs are on the same network, and that LIKApcs is allowed through Windows Firewall on the main PC.',
  errAddressUnreachable:
    'Could not reach {url}. Is the address right and the main PC on the same network?',
  errAddressNotServer: 'Something answered at {url}, but it is not a LIKApcs server.',
  errAddressDifferent:
    '{url} is a different LIKApcs installation (“{name}”) than the one this PC is paired with. Forget the pairing first to move this PC.',
  forgetPairing: 'Forget pairing',
  forgetPairingHint:
    'Removes the device credentials so this PC registers again (for moving it to another server). Staff must approve it again.',
  forgetConfirm: 'Forget the pairing with this server?',
  pairedOnlyWhenUnlocked:
    'Connection settings can be changed only while the PC is unlocked by staff (Ctrl+Alt+A) or before pairing.',
  // ─── settings panel ───
  sectionConnection: 'Connection',
  sectionUpdates: 'Updates',
  sectionGeneral: 'General',
  sectionAbout: 'About this PC',
  status: 'Status',
  installation: 'Installation',
  notPaired: 'Not paired yet',
  pairedStatus: 'Paired',
  updateUpToDate: 'Up to date',
  updateAvailable: 'Version {version} is available',
  updateChecked: 'Last check',
  updateNever: 'Not checked yet',
  updateCheck: 'Check now',
  updateInstall: 'Install now',
  updateInstalling: 'Installing — the client restarts by itself…',
  updateError: 'Update check failed: {error}',
  updateAuto: 'Install updates automatically while the PC is locked and idle',
  updateDuringSession: 'Updates are never installed while a customer session is running.',
  quit: 'Quit LIKApcs Client',
  quitHint:
    'Available before pairing or while the PC is unlocked by staff; the client starts again with Windows.',
  quitLocked: 'The PC is locked. Unlock it first with your staff account (Ctrl+Alt+A).',
  trayStatusOnline: 'Online',
  trayStatusLocked: 'Locked',
  trayStatusSession: 'Session running',
  trayStatusMaintenance: 'Staff maintenance',
  trayStatusSearching: 'Looking for the server',
  trayStatusPending: 'Waiting for approval',
  trayStatusOffline: 'Connection lost',
  traySettings: 'Settings…',
  trayUpdate: 'Check for updates',
  trayQuit: 'Quit LIKApcs Client',
  shortcutsHint: 'Ctrl+Alt+S settings · Ctrl+Alt+A staff unlock',
};
const sq: typeof en = {
  station: 'Stacioni',
  locked: 'Ky PC është i kyçur',
  lockedHint: 'Ju lutem kërkoni stafit të nisë seancën tuaj.',
  free: 'Lojë e lirë',
  remaining: 'Koha e mbetur',
  elapsed: 'Koha e luajtur',
  paused: 'Në pauzë',
  connected: 'I lidhur',
  connecting: 'Duke u lidhur me serverin…',
  offline: 'Lidhja u ndërpre — duke u rilidhur…',
  offlineSession: 'Lidhja u ndërpre — koha juaj vazhdon.',
  noServer: 'Duke kërkuar serverin LIKApcs në rrjet…',
  noServerHint: 'Sigurohuni që PC-ja kryesore është ndezur dhe LIKApcs punon aty.',
  registering: 'Në pritje të miratimit',
  registeringHint:
    'Stafi: hapni LIKApcs Admin → Stacionet → “Pajisje në pritje” dhe caktoni këtë PC në një stacion.',
  computer: 'Emri i kompjuterit',
  machineId: 'ID e makinës',
  server: 'Serveri',
  rejected: 'Ky PC u refuzua nga stafi.',
  rejectedHint:
    'Do të kërkojë përsëri pas disa minutash. Stafi mund ta miratojë në LIKApcs Admin → Stacionet.',
  needsReissue: 'Ky PC ishte miratuar më parë, por kredencialet mungojnë.',
  needsReissueHint:
    'Stafi: LIKApcs Admin → Stacionet → kjo pajisje → “Rilësho token-in”. PC-ja rilidhet vetë.',
  incompatible: 'Ky klient nuk është i përputhshëm me serverin.',
  incompatibleHint:
    'Po instalohet një përditësim. Nëse ky mesazh mbetet, përditësoni klientin nga PC-ja kryesore.',
  updating: 'Po instalohet përditësimi…',
  version: 'Versioni',
  settingsTitle: 'Cilësimet e LIKApcs Client',
  serverAddress: 'Adresa e serverit',
  serverAddressHint:
    'Zakonisht gjendet automatikisht. Vendoseni vetëm kur serveri është në një segment tjetër rrjeti.',
  save: 'Ruaj',
  close: 'Mbyll',
  findServer: 'Gjej në rrjet',
  foundNone: 'Nuk u gjet asnjë server.',
  pairedNote:
    'Ky PC është i çiftuar. Për ta kaluar në një server ose stacion tjetër, revokoni pajisjen në LIKApcs Admin → Stacionet; ajo regjistrohet përsëri automatikisht.',
  language: 'Gjuha',
  maintenance: 'Mirëmbajtje',
  maintenanceBy: 'Zhbllokuar nga',
  locksIn: 'Kyçet pas',
  lockNow: 'Kyçe',
  staffUnlockTitle: 'Zhbllokim nga stafi',
  staffUnlockHint:
    'Zhbllokoni këtë PC për mirëmbajtje me emrin tuaj të përdoruesit dhe fjalëkalimin e LIKApcs. Nuk niset asnjë seancë dhe nuk faturohet asgjë; PC-ja kyçet përsëri automatikisht.',
  username: 'Emri i përdoruesit',
  password: 'Fjalëkalimi',
  unlock: 'Zhblloko',
  cancel: 'Anulo',
  unlocking: 'Po verifikohet me serverin…',
  unlockedUntil: 'Zhbllokuar deri në',
  errInvalidCredentials: 'Emri i përdoruesit ose fjalëkalimi është gabim.',
  errNoPermission: 'Kjo llogari nuk lejohet të zhbllokojë PC-të e stacioneve.',
  errLocked: 'Llogaria u bllokua përkohësisht pas shumë përpjekjeve.',
  errSessionActive: 'Në këtë PC po zhvillohet një seancë klienti.',
  errNotConnected: 'PC-ja ende nuk është lidhur me serverin — provoni përsëri pas pak.',
  errRateLimited: 'Shumë përpjekje — prisni një minutë.',
  errGeneric: 'Serveri e refuzoi kërkesën.',
  errNetwork: 'Serveri nuk u arrit.',
  // ─── pairing / connection ───
  noServerManual:
    'Ose shkruani adresën e serverit që shfaqet në LIKApcs Admin → Stacionet e Lojërave → “Lidh një PC”:',
  serverAddressPlaceholder: 'p.sh. 192.168.1.10 ose 192.168.1.10:4700',
  connect: 'Lidhu',
  connecting2: 'Po kontrollohet…',
  discoveryHint:
    'U gjet “{name}” në rrjet, por nuk pranon lidhje në {url}. Në PC-në kryesore hapni LIKApcs Admin → Stacionet e Lojërave → “Lidh një PC” dhe shtypni “Lejo tani” (Windows Firewall).',
  registeringHint2:
    'Stafi: në PC-në kryesore hapni LIKApcs Admin → Stacionet e Lojërave → “Lidh një PC”, gjeni këtë kompjuter në listë dhe caktojeni në një stacion. PC-ja vazhdon vetë.',
  connectedTo: 'U lidh me “{name}” (serveri {version}). Po regjistrohet ky PC…',
  errAddressInvalid: 'Kjo nuk është adresë e vlefshme. Shembull: 192.168.1.10',
  errAddressTimeout:
    'Asnjë përgjigje nga {url}. Kontrolloni që PC-ja kryesore është ndezur, që të dy PC-të janë në të njëjtin rrjet dhe që LIKApcs lejohet në Windows Firewall në PC-në kryesore.',
  errAddressUnreachable:
    'Nuk u arrit {url}. A është adresa e saktë dhe PC-ja kryesore në të njëjtin rrjet?',
  errAddressNotServer: 'Diçka u përgjigj në {url}, por nuk është server LIKApcs.',
  errAddressDifferent:
    '{url} është një instalim tjetër LIKApcs (“{name}”) nga ai me të cilin është çiftuar ky PC. Harroni çiftimin fillimisht për ta zhvendosur këtë PC.',
  forgetPairing: 'Harro çiftimin',
  forgetPairingHint:
    'Heq kredencialet e pajisjes që ky PC të regjistrohet përsëri (për ta kaluar në një server tjetër). Stafi duhet ta miratojë përsëri.',
  forgetConfirm: 'Të harrohet çiftimi me këtë server?',
  pairedOnlyWhenUnlocked:
    'Cilësimet e lidhjes mund të ndryshohen vetëm kur PC-ja është zhbllokuar nga stafi (Ctrl+Alt+A) ose para çiftimit.',
  // ─── settings panel ───
  sectionConnection: 'Lidhja',
  sectionUpdates: 'Përditësimet',
  sectionGeneral: 'Të përgjithshme',
  sectionAbout: 'Rreth këtij PC-je',
  status: 'Gjendja',
  installation: 'Instalimi',
  notPaired: 'Ende i paçiftuar',
  pairedStatus: 'I çiftuar',
  updateUpToDate: 'I përditësuar',
  updateAvailable: 'Versioni {version} është i disponueshëm',
  updateChecked: 'Kontrolli i fundit',
  updateNever: 'Ende pa kontrolluar',
  updateCheck: 'Kontrollo tani',
  updateInstall: 'Instalo tani',
  updateInstalling: 'Po instalohet — klienti riniset vetë…',
  updateError: 'Kontrolli i përditësimit dështoi: {error}',
  updateAuto: 'Instaloji përditësimet automatikisht kur PC-ja është e kyçur dhe e lirë',
  updateDuringSession: 'Përditësimet nuk instalohen kurrë gjatë një seance klienti.',
  quit: 'Mbyll LIKApcs Client',
  quitHint:
    'E mundur para çiftimit ose kur PC-ja është zhbllokuar nga stafi; klienti niset përsëri bashkë me Windows.',
  quitLocked: 'PC-ja është e kyçur. Zhbllokojeni fillimisht me llogarinë e stafit (Ctrl+Alt+A).',
  trayStatusOnline: 'Në linjë',
  trayStatusLocked: 'E kyçur',
  trayStatusSession: 'Seancë në vazhdim',
  trayStatusMaintenance: 'Mirëmbajtje nga stafi',
  trayStatusSearching: 'Duke kërkuar serverin',
  trayStatusPending: 'Në pritje të miratimit',
  trayStatusOffline: 'Lidhja u ndërpre',
  traySettings: 'Cilësimet…',
  trayUpdate: 'Kontrollo për përditësime',
  trayQuit: 'Mbyll LIKApcs Client',
  shortcutsHint: 'Ctrl+Alt+S cilësimet · Ctrl+Alt+A zhbllokim nga stafi',
};

export const dictionaries: Record<Language, typeof en> = { en, sq };
export type Key = keyof typeof en;
export function t(language: Language, key: Key, vars?: Record<string, string | number>): string {
  const text = dictionaries[language][key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
