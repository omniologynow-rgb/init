/** wallet.ts — create / import / load the agent's Solana keypair. */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import qrcode from "qrcode-terminal";

/** Write a keypair to a solana-keygen-style JSON file with 0600 perms (Unix). */
export function saveKeypair(path: string, kp: Keypair): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { encoding: "utf8" });
  if (process.platform !== "win32") {
    try {
      chmodSync(dirname(path), 0o700);
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  }
}

/** Load a keypair from a JSON file (64-byte secret, or 32-byte seed). */
export function loadKeypair(path: string): Keypair {
  const arr = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(arr) || (arr.length !== 64 && arr.length !== 32)) {
    throw new Error(`Keypair file ${path} is not a valid Solana keypair (expected a JSON array of 64 numbers).`);
  }
  const bytes = Uint8Array.from(arr as number[]);
  return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
}

export function generateKeypair(): Keypair {
  return Keypair.generate();
}

/** Print a scannable ASCII QR for a wallet address (small variant). */
export function printAddressQr(address: string): Promise<void> {
  return new Promise((resolve) => {
    qrcode.generate(address, { small: true }, (art: string) => {
      console.log(art);
      resolve();
    });
  });
}
