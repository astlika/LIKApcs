// Makes the keystore that signs the release APK — without a private key being stored anywhere.
//
// Android installs an update only when it carries the same signature as the installed app, so
// every release must be signed with the same key. That key is not kept in a file and not in a
// secret of its own: it is derived here, each time, from a secret the repository already has
// (the release workflow's TAURI_SIGNING_PRIVATE_KEY, passed in as LIKALIVE_SIGNING_SEED). Its
// public half is the certificate next to this file (release-certificate.crt: public, the same
// one that is inside every APK). The keystore written here lives only for one build.
//
//   eval "$(LIKALIVE_SIGNING_SEED=… node signing-key.mjs <out-dir>)"   # sets the LIKALIVE_* variables
//
// If the seed secret is ever replaced, the derived key no longer fits the certificate and this
// script stops. Then either the old secret is restored, or a new certificate is made (delete
// release-certificate.crt, run once, commit the file this script writes) — and whoever has the
// app installed must uninstall it once before the next version installs.
//
// Needs Node 20+ and the `openssl` command.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CERTIFICATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'release-certificate.crt',
);
const out = process.argv[2];
const seed = (process.env.LIKALIVE_SIGNING_SEED ?? '').trim();
const say = (line) => process.stderr.write(`${line}\n`);

if (!out) {
  say('usage: LIKALIVE_SIGNING_SEED=… node signing-key.mjs <out-dir>');
  process.exit(2);
}
if (seed.length < 32) {
  say('signing-key: LIKALIVE_SIGNING_SEED is missing or too short to be a secret.');
  process.exit(2);
}

// 1. The private key: a number below the order of the P-256 curve, derived from the seed (HKDF).
const ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
let scalar = null;
for (let round = 0; scalar === null; round++) {
  const info = `android signing key v1${round ? ` #${round}` : ''}`;
  const bytes = Buffer.from(crypto.hkdfSync('sha256', seed, 'likalivepcs', info, 32));
  const value = BigInt(`0x${bytes.toString('hex')}`);
  if (value > 0n && value < ORDER) scalar = bytes;
}
const curve = crypto.createECDH('prime256v1');
curve.setPrivateKey(scalar);
const point = curve.getPublicKey(); // 0x04, X (32 bytes), Y (32 bytes)
const b64 = (buffer) => buffer.toString('base64url');
const jwk = {
  kty: 'EC',
  crv: 'P-256',
  d: b64(scalar),
  x: b64(point.subarray(1, 33)),
  y: b64(point.subarray(33)),
};

fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const keyFile = path.join(out, 'key.pem');
fs.writeFileSync(
  keyFile,
  crypto.createPrivateKey({ key: jwk, format: 'jwk' }).export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600 },
);

/** Returns the exit code. The private key file is removed whatever happens (see `finally`). */
function makeKeystore() {
  // 2. The certificate: the one in the repository, which must belong to this key.
  let certificateFile = CERTIFICATE;
  if (fs.existsSync(CERTIFICATE)) {
    const known = new crypto.X509Certificate(fs.readFileSync(CERTIFICATE)).publicKey.export({
      format: 'jwk',
    });
    if (known.x !== jwk.x || known.y !== jwk.y) {
      say('signing-key: the key derived from the seed does not belong to release-certificate.crt.');
      say(
        '  The seed secret has changed since the certificate was made. See the top of signing-key.mjs.',
      );
      return 3;
    }
  } else {
    // First time (or after a deliberate reset): a new self-signed certificate, valid for 50 years.
    certificateFile = path.join(out, 'release-certificate.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-x509',
        '-key',
        keyFile,
        '-sha256',
        '-days',
        '18250',
        '-subj',
        '/CN=likalivepcs/O=LIKApcs',
        '-out',
        certificateFile,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    say(`signing-key: NEW certificate written to ${certificateFile}`);
    say(
      '  Commit it as apps/likapcs-live/android/signing/release-certificate.crt to keep this signature.',
    );
  }
  const certificate = new crypto.X509Certificate(fs.readFileSync(certificateFile));
  say(
    `signing-key: certificate ${certificate.subject.replace(/\n/g, ', ')}, SHA-256 ${certificate.fingerprint256}`,
  );

  // 3. A keystore for this one build, locked with a password made up now.
  const password = crypto.randomBytes(24).toString('hex');
  const keystore = path.join(out, 'release.p12');
  execFileSync(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-inkey',
      keyFile,
      '-in',
      certificateFile,
      '-name',
      'likalive',
      '-out',
      keystore,
      '-passout',
      'env:LIKALIVE_P12_PASSWORD',
    ],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, LIKALIVE_P12_PASSWORD: password },
    },
  );
  fs.chmodSync(keystore, 0o600);
  process.stdout.write(
    [
      `export LIKALIVE_KEYSTORE='${keystore}'`,
      `export LIKALIVE_KEYSTORE_PASSWORD='${password}'`,
      `export LIKALIVE_KEY_ALIAS='likalive'`,
      `export LIKALIVE_KEY_PASSWORD='${password}'`,
      '',
    ].join('\n'),
  );
  return 0;
}

try {
  process.exitCode = makeKeystore();
} finally {
  fs.rmSync(keyFile, { force: true });
}
