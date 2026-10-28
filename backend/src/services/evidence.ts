/**
 * Evidence storage adapter.
 *
 * Three modes, in priority order:
 *   1. Pinata pinning service  (PINATA_JWT set)          -> real IPFS pin, CID from Pinata
 *   2. Local Kubo IPFS daemon  (IPFS_API_URL set)        -> real IPFS pin on that node
 *   3. Local content store     (neither configured)      -> CIDv1 raw, NOT published to IPFS
 *
 * Mode 3 exists so the prototype is demonstrable without credentials. It is deliberately
 * named `local-content-store` everywhere it surfaces: a content hash stored on one disk
 * is not IPFS, and presenting it as such would be false.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "../config.js";

export type EvidenceProvider = "pinata" | "local-ipfs" | "local-content-store";

export interface EvidenceUpload {
  cid: string;
  provider: EvidenceProvider;
  size: number;
  sha256: string;
  gatewayUrl: string;
  filename: string;
  contentType: string;
}

const MAX_BYTES = 10 * 1024 * 1024;

export function evidenceMode(): {
  provider: EvidenceProvider;
  isIpfs: boolean;
  detail: string;
} {
  if (config.PINATA_JWT) {
    return {
      provider: "pinata",
      isIpfs: true,
      detail: "Pinata pinning service",
    };
  }
  if (config.IPFS_API_URL) {
    return {
      provider: "local-ipfs",
      isIpfs: true,
      detail: `local Kubo daemon at ${config.IPFS_API_URL}`,
    };
  }
  return {
    provider: "local-content-store",
    isIpfs: false,
    detail:
      "No PINATA_JWT or IPFS_API_URL configured. Files are stored locally under a " +
      "CIDv1 raw identifier and are NOT retrievable from the IPFS network.",
  };
}

export async function uploadEvidence(
  data: Buffer,
  filename: string,
  contentType: string
): Promise<EvidenceUpload> {
  if (data.length === 0) throw new EvidenceError("empty file", 400);
  if (data.length > MAX_BYTES) throw new EvidenceError("file exceeds 10 MiB limit", 413);

  const safeName = sanitizeFilename(filename);
  const sha256 = createHash("sha256").update(data).digest("hex");

  const mode = evidenceMode();
  if (mode.provider === "pinata") {
    const cid = await pinToPinata(data, safeName, contentType);
    return {
      cid,
      provider: "pinata",
      size: data.length,
      sha256,
      gatewayUrl: `${trimSlash(config.PINATA_GATEWAY_URL)}/ipfs/${cid}`,
      filename: safeName,
      contentType,
    };
  }

  if (mode.provider === "local-ipfs") {
    const cid = await addToKubo(data, safeName);
    return {
      cid,
      provider: "local-ipfs",
      size: data.length,
      sha256,
      gatewayUrl: `/api/evidence/${cid}`,
      filename: safeName,
      contentType,
    };
  }

  const cid = rawCidV1(data);
  const dir = config.IPFS_LOCAL_DIR;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${cid}.bin`), data);
  await writeFile(
    join(dir, `${cid}.json`),
    JSON.stringify({ filename: safeName, contentType, sha256, size: data.length }, null, 2)
  );

  return {
    cid,
    provider: "local-content-store",
    size: data.length,
    sha256,
    gatewayUrl: `/api/evidence/${cid}`,
    filename: safeName,
    contentType,
  };
}

/** Reads evidence bytes from the local store, local Kubo, or the public gateway. */
export async function readEvidence(
  cid: string
): Promise<{ data: Buffer; contentType: string; filename: string } | null> {
  if (!/^[A-Za-z0-9]{20,128}$/.test(cid)) return null;

  try {
    const data = await readFile(join(config.IPFS_LOCAL_DIR, `${cid}.bin`));
    const meta = JSON.parse(
      await readFile(join(config.IPFS_LOCAL_DIR, `${cid}.json`), "utf8")
    ) as { filename?: string; contentType?: string };
    return {
      data,
      contentType: meta.contentType ?? "application/octet-stream",
      filename: meta.filename ?? cid,
    };
  } catch {
    // Not in the local store.
  }

  if (config.IPFS_API_URL) {
    try {
      const res = await fetch(
        `${trimSlash(config.IPFS_API_URL)}/api/v0/cat?arg=${encodeURIComponent(cid)}`,
        { method: "POST" }
      );
      if (res.ok) {
        return {
          data: Buffer.from(await res.arrayBuffer()),
          contentType: "application/octet-stream",
          filename: cid,
        };
      }
    } catch {
      // Fall through to the public gateway.
    }
  }

  if (config.IPFS_GATEWAY_URL) {
    try {
      const res = await fetch(`${trimSlash(config.IPFS_GATEWAY_URL)}/${cid}`);
      if (res.ok) {
        return {
          data: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get("content-type") ?? "application/octet-stream",
          filename: cid,
        };
      }
    } catch {
      // Not available anywhere.
    }
  }

  return null;
}

export class EvidenceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function pinToPinata(data: Buffer, filename: string, contentType: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: contentType }), filename);
  form.append("pinataMetadata", JSON.stringify({ name: filename }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.PINATA_JWT}` },
    body: form,
  });
  if (!res.ok) {
    throw new EvidenceError(`Pinata upload failed: HTTP ${res.status}`, 502);
  }
  const json = (await res.json()) as { IpfsHash?: string };
  if (!json.IpfsHash) throw new EvidenceError("Pinata response had no IpfsHash", 502);
  return json.IpfsHash;
}

async function addToKubo(data: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), filename);

  const res = await fetch(
    `${trimSlash(config.IPFS_API_URL!)}/api/v0/add?pin=true&cid-version=1`,
    { method: "POST", body: form }
  );
  if (!res.ok) {
    throw new EvidenceError(`IPFS daemon add failed: HTTP ${res.status}`, 502);
  }
  // Kubo returns newline-delimited JSON; the final object describes the added file.
  const lines = (await res.text()).trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as { Hash?: string };
  if (!last.Hash) throw new EvidenceError("IPFS daemon response had no Hash", 502);
  return last.Hash;
}

/** CIDv1 (raw codec, sha2-256 multihash) encoded as multibase base32 lower-case. */
export function rawCidV1(data: Buffer): string {
  const digest = createHash("sha256").update(data).digest();
  const bytes = Buffer.concat([
    Buffer.from([0x01, 0x55, 0x12, 0x20]), // cidv1, raw, sha2-256, 32 bytes
    digest,
  ]);
  return `b${base32Lower(bytes)}`;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Lower(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "evidence";
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "evidence";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
