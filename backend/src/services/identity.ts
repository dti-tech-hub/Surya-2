/**
 * Minimal DID / Verifiable Credential prototype.
 *
 * DID method: `did:ethr:<chainId>:<address>` (EIP-1056 identifier shape). The DID
 * document exposes the address as an `EcdsaSecp256k1RecoveryMethod2020` verification
 * method keyed by an `eip155` blockchainAccountId.
 *
 * Credentials are W3C VC 1.1 JSON documents with an Ethereum `personal_sign` proof.
 * This is a prototype proof suite (`EthereumPersonalSignature2021`), not a standardized
 * VC proof type; it is verified locally and anchored on-chain only as a keccak256 hash
 * by {CredentialRegistry}. No PII is written to the chain.
 */
import { Contract, JsonRpcProvider, Wallet, keccak256, solidityPackedKeccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { getChainClient, loadAbi } from "../chain/client.js";

export interface DidDocument {
  "@context": string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    blockchainAccountId: string;
  }>;
  authentication: string[];
  assertionMethod: string[];
}

export interface VerifiableCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: Record<string, unknown> & { id: string };
  proof: {
    type: string;
    created: string;
    verificationMethod: string;
    proofPurpose: string;
    proofValue: string;
  };
}

export interface IssueOptions {
  subject: string;
  schemaType: string;
  claims?: Record<string, unknown>;
  expiresInDays?: number;
  attestOnChain?: boolean;
}

export interface IssuedCredential {
  credential: VerifiableCredential;
  credentialHash: string;
  schemaType: string;
  subject: string;
  issuer: string;
  onChain: {
    attested: boolean;
    transactionHash?: string;
    credentialId?: string;
    reason?: string;
  };
}

export function issuerAddress(): string | null {
  const key = config.VC_ISSUER_PRIVATE_KEY ?? config.VERAMO_AGENT_PRIVATE_KEY;
  if (!key) return null;
  try {
    return new Wallet(key).address;
  } catch {
    return null;
  }
}

export function didForAddress(address: string, chainId = config.CHAIN_ID): string {
  return `did:ethr:${chainId}:${address}`;
}

export function didDocument(address: string, chainId = config.CHAIN_ID): DidDocument {
  const did = didForAddress(address, chainId);
  const method = `${did}#controller`;
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/secp256k1recovery-2020/v2",
    ],
    id: did,
    verificationMethod: [
      {
        id: method,
        type: "EcdsaSecp256k1RecoveryMethod2020",
        controller: did,
        blockchainAccountId: `eip155:${chainId}:${address}`,
      },
    ],
    authentication: [method],
    assertionMethod: [method],
  };
}

export async function issueCredential(options: IssueOptions): Promise<IssuedCredential> {
  const key = config.VC_ISSUER_PRIVATE_KEY ?? config.VERAMO_AGENT_PRIVATE_KEY;
  if (!key) {
    throw new IdentityError(
      "No VC issuer key configured. Set VC_ISSUER_PRIVATE_KEY (or VERAMO_AGENT_PRIVATE_KEY) to enable issuance.",
      503
    );
  }

  const wallet = new Wallet(key);
  const issuer = config.VC_ISSUER_DID ?? didForAddress(wallet.address);
  const now = new Date();
  const days = Math.min(Math.max(options.expiresInDays ?? 365, 1), 3650);
  const expiry = new Date(now.getTime() + days * 86_400_000);

  const unsigned = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: `urn:uuid:${randomUUID()}`,
    type: ["VerifiableCredential", options.schemaType],
    issuer,
    issuanceDate: now.toISOString(),
    expirationDate: expiry.toISOString(),
    credentialSubject: {
      id: didForAddress(options.subject),
      ...(options.claims ?? {}),
    },
  };

  // personal_sign over a stable JSON encoding. Stable key ordering matters: the verifier
  // must reconstruct exactly the bytes that were signed, regardless of JSON member order.
  const proofValue = await wallet.signMessage(stableStringify(unsigned));
  const credential: VerifiableCredential = {
    ...unsigned,
    proof: {
      type: "EthereumPersonalSignature2021",
      created: now.toISOString(),
      verificationMethod: `${issuer}#controller`,
      proofPurpose: "assertionMethod",
      proofValue,
    },
  };

  const credentialHash = keccak256(toUtf8Bytes(stableStringify(credential)));
  const onChain = options.attestOnChain
    ? await attestOnChain(wallet, options.subject, credentialHash, options.schemaType, expiry)
    : { attested: false, reason: "on-chain attestation not requested" };

  return {
    credential,
    credentialHash,
    schemaType: options.schemaType,
    subject: options.subject,
    issuer,
    onChain,
  };
}

export async function verifyCredential(
  input: unknown,
  options: { checkOnChain?: boolean } = {}
): Promise<{
  valid: boolean;
  reason?: string;
  issuer?: string;
  subject?: string;
  schemaType?: string;
  credentialHash?: string;
  onChain?: { found: boolean; valid: boolean };
}> {
  const credential = input as VerifiableCredential;
  if (
    !credential ||
    typeof credential !== "object" ||
    !credential.proof?.proofValue ||
    !credential.issuer ||
    !credential.credentialSubject?.id
  ) {
    return { valid: false, reason: "not a verifiable credential" };
  }

  const { proof, ...unsigned } = credential;
  let recovered: string;
  try {
    recovered = verifyMessage(stableStringify(unsigned), proof.proofValue);
  } catch {
    return { valid: false, reason: "malformed signature" };
  }

  const expectedDid = config.VC_ISSUER_DID ?? didForAddress(recovered);
  if (credential.issuer !== expectedDid) {
    return { valid: false, reason: "issuer does not match the signing key" };
  }

  if (new Date(credential.expirationDate).getTime() <= Date.now()) {
    return { valid: false, reason: "credential expired" };
  }

  const address = credential.credentialSubject.id.split(":").pop() ?? "";
  const credentialHash = keccak256(toUtf8Bytes(stableStringify(credential)));
  const onChain = options.checkOnChain
    ? await lookupOnChain(address, credentialHash, credential.type[1] ?? "")
    : undefined;

  return {
    valid: true,
    issuer: credential.issuer,
    subject: address,
    schemaType: credential.type[1],
    credentialHash,
    onChain,
  };
}

async function attestOnChain(
  wallet: Wallet,
  subject: string,
  credentialHash: string,
  schemaType: string,
  expiry: Date
): Promise<{ attested: boolean; transactionHash?: string; credentialId?: string; reason?: string }> {
  const client = getChainClient();
  const address = config.CREDENTIALS_ADDRESS ?? client.addresses.CredentialRegistry;
  if (!address) {
    return { attested: false, reason: "CredentialRegistry address is not configured" };
  }

  try {
    const provider = new JsonRpcProvider(config.RPC_URL, config.CHAIN_ID);
    const signer = wallet.connect(provider);
    const registry = new Contract(address, loadAbi("CredentialRegistry"), signer);
    const tx = await registry.attestCredential(
      subject,
      credentialHash,
      schemaType,
      Math.floor(expiry.getTime() / 1000)
    );
    await tx.wait();
    return {
      attested: true,
      transactionHash: tx.hash,
      credentialId: solidityPackedKeccak256(["bytes32", "address"], [credentialHash, subject]),
    };
  } catch (error) {
    return { attested: false, reason: (error as Error).message };
  }
}

async function lookupOnChain(
  subject: string,
  credentialHash: string,
  schemaType: string
): Promise<{ found: boolean; valid: boolean }> {
  const address = config.CREDENTIALS_ADDRESS ?? getChainClient().addresses.CredentialRegistry;
  if (!address) return { found: false, valid: false };
  try {
    const registry = getChainClient().at("CredentialRegistry", address);
    const credentialId = solidityPackedKeccak256(["bytes32", "address"], [credentialHash, subject]);
    const record = (await registry.getCredential(credentialId)) as any;
    const found = Number(record.issuedAt) !== 0;
    if (!found) return { found: false, valid: false };
    const valid = await registry.isCredentialValid(subject, credentialHash, schemaType);
    return { found: true, valid: Boolean(valid) };
  } catch {
    return { found: false, valid: false };
  }
}

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** JSON.stringify with recursively sorted keys, so signatures survive member reordering. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(object[k])}`).join(",")}}`;
}
