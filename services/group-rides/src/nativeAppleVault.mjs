import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
/** Envelope encryption handles provider tokens larger than KMS Encrypt's 4KB limit.
 * The login role needs GenerateDataKey only; deletion has separately-scoped Decrypt. */
export function createAppleTokenEncryption({ kms, keyId }) {
  if (!kms?.send || !keyId) throw new Error('Provider encryption must be configured.');
  async function prepare(subject) {
    if (typeof subject !== 'string' || !subject || subject.length > 256) throw new Error('Provider encryption input invalid.');
    const context = { purpose: 'bendbound-native-apple', subject: createHash('sha256').update(subject).digest('hex') };
    const result = await kms.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: context }));
    const key = result.Plaintext && Buffer.from(result.Plaintext);
    const dispose = () => { key?.fill(0); result.Plaintext?.fill(0); };
    if (!key || key.length !== 32 || !result.CiphertextBlob?.length) { dispose(); throw new Error('Provider encryption unavailable.'); }
    let used = false;
    return {
      dispose,
      encrypt(refreshToken) {
        if (used || typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 16_384) throw new Error('Provider encryption input invalid.');
        used = true;
        const plain = Buffer.from(refreshToken, 'utf8');
        try {
          const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
          cipher.setAAD(Buffer.from(JSON.stringify(context)));
          const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
          return { version: 1, context, wrappedKey: Buffer.from(result.CiphertextBlob).toString('base64'),
            iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
        } finally { dispose(); plain.fill(0); }
      },
    };
  }
  const encrypt = async (subject, token) => { const prepared = await prepare(subject); try { return prepared.encrypt(token); } finally { prepared.dispose(); } };
  encrypt.prepare = prepare;
  return encrypt;
}
/** Only the hold-gated cleanup role receives Decrypt permission. */
export function createAppleTokenDecryption({ kms, keyId }) {
  if (!kms?.send || !keyId) throw new Error('Provider decryption must be configured.');
  const decode = (s, max, length) => {
    if (typeof s !== 'string' || !s || s.length > max || Buffer.from(s, 'base64').toString('base64') !== s) throw new Error('Invalid provider envelope.');
    const bytes = Buffer.from(s, 'base64');
    if (length && bytes.length !== length) throw new Error('Invalid provider envelope.');
    return bytes;
  };
  return async (subject, envelope) => {
    const expected = { purpose: 'bendbound-native-apple', subject: createHash('sha256').update(subject).digest('hex') };
    if (envelope?.version !== 1 || !envelope.context || Object.keys(envelope.context).length !== 2 || envelope.context.purpose !== expected.purpose || envelope.context.subject !== expected.subject) throw new Error('Invalid provider envelope.');
    const iv = decode(envelope.iv, 32, 12), tag = decode(envelope.tag, 32, 16);
    const ciphertext = decode(envelope.ciphertext, 100_000), wrappedKey = decode(envelope.wrappedKey, 10_000);
    const response = await kms.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: wrappedKey, EncryptionContext: expected }));
    const key = response.Plaintext && Buffer.from(response.Plaintext);
    let plaintext;
    try {
      if (!key || key.length !== 32) throw new Error('Provider decryption unavailable.');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(JSON.stringify(expected))); decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (!plaintext.length || plaintext.length > 65536) throw new Error('Provider decryption unavailable.');
      return plaintext.toString('utf8');
    } finally { key?.fill(0); response.Plaintext?.fill(0); plaintext?.fill(0); }
  };
}
