import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/** AES-256-GCM for publish-target credentials. Key from ABW_SECRET_KEY env. */
function key(): Buffer {
  const k = process.env.ABW_SECRET_KEY;
  if (!k) throw new Error("ABW_SECRET_KEY is not set");
  return createHash("sha256").update(k).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  if (!value.startsWith("enc:")) return value; // legacy/plaintext passthrough
  const [, ivB64, tagB64, dataB64] = value.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64!, "base64")), decipher.final()]).toString("utf8");
}
