import { generateKeyPairSync, sign } from 'node:crypto';

const receipt = Buffer.from(process.argv[2] ?? '', 'base64');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signature = sign('sha256', receipt, { key: privateKey, dsaEncoding: 'ieee-p1363' });
process.stdout.write(`${JSON.stringify({ publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature: signature.toString('base64') })}\n`);
