// pennydata: pay-per-call data for AI agents, paid with x402 in USDC on Base.
// The service list and types come from ./services.ts, generated from the shop's registry.

import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig, type PaymentRequirements } from "@x402/fetch";
import { SERVICES, type PennyDataServices, type ServiceName } from "./services.js";

export * from "./services.js";

export const DEFAULT_BASE_URL = "https://pennydatahq.com";
export const BASE = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";

/**
 * Anything that can sign an x402 payment: a viem account (privateKeyToAccount, a wallet client's
 * account) or a CDP server account (cdp.evm.getOrCreateAccount).
 */
export type Wallet = {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, any>;
    types: Record<string, any>;
    primaryType: string;
    message: Record<string, any>;
  }): Promise<`0x${string}`>;
};

export type Receipt = {
  service: ServiceName;
  /** Amount paid, in USDC (6 decimals). */
  amountUsd: string;
  network: string;
  transaction: string;
  payer?: string;
};

export type PennyDataOptions = {
  /** The wallet that pays: a viem account or a CDP server account holding USDC on Base. */
  wallet: Wallet;
  /** Defaults to https://pennydatahq.com. */
  baseUrl?: string;
  /** CAIP-2 network to pay on. Defaults to Base mainnet (eip155:8453). */
  network?: typeof BASE | typeof BASE_SEPOLIA;
  /** Refuse any single call above this many USDC, on top of each service's own fixed price. */
  maxPriceUsd?: number;
  /** Called after every paid call with its on-chain receipt. */
  onReceipt?: (receipt: Receipt) => void;
  /** A fetch implementation; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
};

export type PennyDataErrorCode = "bad_input" | "not_found" | "upstream" | "payment" | "price" | "http";

/** A failed call. Only "payment" or "http" errors can follow a charge; 400, 404 and 502 are never charged. */
export class PennyDataError extends Error {
  constructor(
    message: string,
    readonly code: PennyDataErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PennyDataError";
  }
}

const CODES: Record<number, PennyDataErrorCode> = { 400: "bad_input", 404: "not_found", 502: "upstream", 402: "payment" };

export type PennyData = PennyDataServices & {
  /** Every service's route, path parameter and price. */
  readonly services: typeof SERVICES;
};

/**
 * Creates a client with 1 typed function per service.
 *
 * ```ts
 * const pd = pennydata({ wallet: privateKeyToAccount(process.env.KEY as `0x${string}`) });
 * const company = await pd.companyLookup("02366777");
 * ```
 */
export function pennydata(options: PennyDataOptions): PennyData {
  const { wallet, network = BASE, maxPriceUsd, onReceipt } = options;
  if (!wallet?.address || typeof wallet.signTypedData !== "function")
    throw new Error("pennydata: pass a wallet (a viem account or a CDP server account).");
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const baseFetch = options.fetch ?? globalThis.fetch;
  const scheme = new ExactEvmScheme(wallet);
  const ceiling = maxPriceUsd === undefined ? undefined : BigInt(Math.round(maxPriceUsd * 1_000_000));

  // 1 paying fetch per service: it only accepts a 402 on our network at no more than that service's
  // fixed price (and the caller's ceiling), so a changed or spoofed price is never paid.
  const payers = new Map<ServiceName, typeof baseFetch>();
  function payerFor(name: ServiceName) {
    let payer = payers.get(name);
    if (!payer) {
      const limit = BigInt(SERVICES[name].priceAtomic);
      const priced = (reqs: PaymentRequirements[]) =>
        reqs.filter((r) => r.network === network && BigInt(r.amount) <= limit && (ceiling === undefined || BigInt(r.amount) <= ceiling));
      payer = wrapFetchWithPaymentFromConfig(baseFetch, {
        schemes: [{ network, client: scheme }],
        policies: [(_version, reqs) => priced(reqs)],
      });
      payers.set(name, payer);
    }
    return payer;
  }

  async function call(name: ServiceName, value: string): Promise<unknown> {
    if (typeof value !== "string" || !value.trim()) throw new PennyDataError(`${name}: pass a non-empty string.`, "bad_input");
    const { segment, priceUsd } = SERVICES[name];
    const url = `${baseUrl}/api/${segment}/${encodeURIComponent(value.trim())}`;
    let res: Response;
    try {
      res = await payerFor(name)(url, { headers: { accept: "application/json" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no .*(payment requirements|matching)|policy|policies/i.test(message))
        throw new PennyDataError(`${name}: the shop asked for more than ${priceUsd} USDC or another network, so nothing was paid.`, "price");
      throw new PennyDataError(`${name}: payment failed: ${message}`, "payment");
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      let error = (body as { error?: string } | null)?.error ?? res.statusText;
      // A 402 after paying: settlement failed, so nothing was charged. The reason is in PAYMENT-RESPONSE.
      const failed = res.status === 402 ? res.headers.get("PAYMENT-RESPONSE") : null;
      if (failed) {
        try {
          const settle = decodePaymentResponseHeader(failed);
          error = `payment not settled, not charged (${settle.errorReason ?? "unknown"}${settle.errorMessage ? `: ${settle.errorMessage.split("\n")[0]}` : ""})`;
        } catch {}
      }
      throw new PennyDataError(`${name}: ${error}`, CODES[res.status] ?? "http", res.status);
    }
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (header && onReceipt) {
      try {
        const settled = decodePaymentResponseHeader(header);
        onReceipt({
          service: name,
          amountUsd: settled.amount ? (Number(settled.amount) / 1_000_000).toString() : priceUsd,
          network: settled.network,
          transaction: settled.transaction,
          payer: settled.payer,
        });
      } catch {}
    }
    return body;
  }

  const client = { services: SERVICES } as Record<string, unknown>;
  for (const name of Object.keys(SERVICES) as ServiceName[]) client[name] = (value: string) => call(name, value);
  return client as unknown as PennyData;
}

export default pennydata;
