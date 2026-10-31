// The pure parts of packaging the approver as an MSIX (issue #101): the identity registry, the package family name, the AppxManifest.xml text, the placeholder logos and the layout
// filter. Nothing here touches a certificate store, installs anything or starts a process; scripts/package-windows-approver-msix.mjs does the file work and
// scripts/approver-msix-install.ps1 does the host work. Tests: test/approver-msix.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const IDENTITY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approver-msix-identity.json');

const NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/u; // MSIX package Name: 3..50 characters, letters, digits, dot, dash
const PUBLISHER_RULE = /^CN=[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/u; // one plain CN, so XML, the certificate subject and the PowerShell script need no escaping
const VERSION_RULE = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.0$/u; // the last part must stay 0 for a Store-style package; a sideloaded one is fine with it too
const EXECUTABLE_RULE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}\.exe$/u;
const WINDOWS_VERSION_RULE = /^10\.0\.\d{5}\.0$/u;
const TEXT_RULE = /^[A-Za-z0-9][A-Za-z0-9 .,()'-]{0,199}$/u;
const FIELDS = ['packageName', 'publisher', 'publisherDisplayName', 'displayName', 'description', 'version', 'applicationId', 'executable', 'alias', 'minWindowsVersion', 'maxWindowsVersionTested', 'certificateYears'];

/** @returns {object} the registry, validated; throws `invalid_identity: ...` (one line) for any missing, extra or malformed field. */
export function parseIdentity(text) {
  let identity;
  try { identity = JSON.parse(text); } catch { throw new Error('invalid_identity: not JSON'); }
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('invalid_identity: not an object');
  const extra = Object.keys(identity).filter((key) => key !== '_comment' && !FIELDS.includes(key));
  if (extra.length > 0) throw new Error(`invalid_identity: unknown field ${extra[0]}`);
  const rules = {
    packageName: NAME_RULE, publisher: PUBLISHER_RULE, publisherDisplayName: TEXT_RULE, displayName: TEXT_RULE, description: TEXT_RULE, version: VERSION_RULE,
    applicationId: /^[A-Za-z][A-Za-z0-9]{0,63}$/u, executable: EXECUTABLE_RULE, alias: EXECUTABLE_RULE, minWindowsVersion: WINDOWS_VERSION_RULE, maxWindowsVersionTested: WINDOWS_VERSION_RULE,
  };
  for (const [field, rule] of Object.entries(rules)) {
    if (typeof identity[field] !== 'string' || !rule.test(identity[field])) throw new Error(`invalid_identity: ${field}`);
  }
  if (!Number.isInteger(identity.certificateYears) || identity.certificateYears < 1 || identity.certificateYears > 10) throw new Error('invalid_identity: certificateYears');
  return identity;
}

export function loadIdentity(file = IDENTITY_FILE) {
  return parseIdentity(fs.readFileSync(file, 'utf8'));
}

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** The 13-character publisher id Windows derives from the Publisher string: the first 8 bytes of SHA-256 over its UTF-16LE bytes, base32 (Crockford-like alphabet, no padding). */
export function publisherId(publisher) {
  const digest = createHash('sha256').update(Buffer.from(publisher, 'utf16le')).digest().subarray(0, 8);
  let bits = '';
  for (const byte of digest) bits += byte.toString(2).padStart(8, '0');
  bits = bits.padEnd(65, '0');
  let id = '';
  for (let i = 0; i < 65; i += 5) id += BASE32[Number.parseInt(bits.slice(i, i + 5), 2)];
  return id;
}

/** The package family name `<Name>_<publisherId>`: what Windows scopes the Hello credential to. */
export function packageFamilyName(identity) {
  return `${identity.packageName}_${publisherId(identity.publisher)}`;
}

const escapeXml = (value) => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');

/** The AppxManifest.xml text. A console program started through an app execution alias (subsystem console), full trust (a normal desktop process, not an AppContainer), x64. No capability except runFullTrust. */
export function buildManifest(identity) {
  const e = escapeXml;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"',
    '         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"',
    '         xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5"',
    '         xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"',
    '         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"',
    '         IgnorableNamespaces="uap uap5 desktop4 rescap">',
    `  <Identity Name="${e(identity.packageName)}" Publisher="${e(identity.publisher)}" Version="${e(identity.version)}" ProcessorArchitecture="x64" />`,
    '  <Properties>',
    `    <DisplayName>${e(identity.displayName)}</DisplayName>`,
    `    <PublisherDisplayName>${e(identity.publisherDisplayName)}</PublisherDisplayName>`,
    '    <Logo>Assets\\StoreLogo.png</Logo>',
    '  </Properties>',
    '  <Dependencies>',
    `    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${e(identity.minWindowsVersion)}" MaxVersionTested="${e(identity.maxWindowsVersionTested)}" />`,
    '  </Dependencies>',
    '  <Resources>',
    '    <Resource Language="en-us" />',
    '  </Resources>',
    '  <Applications>',
    `    <Application Id="${e(identity.applicationId)}" Executable="${e(identity.executable)}" EntryPoint="Windows.FullTrustApplication" desktop4:Subsystem="console" desktop4:SupportsMultipleInstances="true">`,
    `      <uap:VisualElements DisplayName="${e(identity.displayName)}" Description="${e(identity.description)}" BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" AppListEntry="none" />`,
    '      <Extensions>',
    `        <uap5:Extension Category="windows.appExecutionAlias" Executable="${e(identity.executable)}" EntryPoint="Windows.FullTrustApplication">`,
    '          <uap5:AppExecutionAlias desktop4:Subsystem="console">',
    `            <uap5:ExecutionAlias Alias="${e(identity.alias)}" />`,
    '          </uap5:AppExecutionAlias>',
    '        </uap5:Extension>',
    '      </Extensions>',
    '    </Application>',
    '  </Applications>',
    '  <Capabilities>',
    '    <rescap:Capability Name="runFullTrust" />',
    '  </Capabilities>',
    '</Package>',
    '',
  ].join('\r\n');
}

/** The logos the manifest names (the package must contain them; they are never shown, the app has no list entry). */
export const LOGOS = Object.freeze([
  { file: 'StoreLogo.png', size: 50 },
  { file: 'Square44x44Logo.png', size: 44 },
  { file: 'Square150x150Logo.png', size: 150 },
]);

/** A solid-colour square PNG (8-bit RGB), built with node:zlib only. */
export function solidPng(size, [red, green, blue] = [0x1f, 0x3a, 0x5f]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2; // 8 bits per channel, colour type 2 (RGB)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Which files of the publish folder go into the package: everything except debug symbols and the build's own hash file (those are not part of the program). */
export function belongsInPackage(relativePath) {
  const name = relativePath.split(/[\\/]/u).at(-1).toLowerCase();
  return !name.endsWith('.pdb') && name !== 'alberaapprover.exe.manifest.json';
}
