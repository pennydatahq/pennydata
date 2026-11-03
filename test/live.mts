// End-to-end test of the packed pennydata library, run from a separate folder where the tarball is
// installed (so it tests what npm would ship). Not part of the package.
//  1. Live shop (https://pennydatahq.com, Base mainnet), unpaid: the library's 12 routes and prices match
//     /.well-known/x402 and every live 402; the price guard refuses an over-ceiling or wrong-network 402
//     before signing anything.
//  2. Testnet: every function paid on Base Sepolia through a local seller running the same code
//     (TEST_SELLER_URL), with a viem account (BUYER_PRIVATE_KEY) and a CDP server account
//     (CDP_TEST_ACCOUNT, looked up by name, never created). 400 and 404 throw and are not charged.
// Env: BUYER_PRIVATE_KEY, TEST_SELLER_URL, and for the CDP part CDP_API_KEY_ID, CDP_API_KEY_SECRET,
// CDP_WALLET_SECRET, CDP_TEST_ACCOUNT.

import { BASE_SEPOLIA, PennyDataError, SERVICES, pennydata, type Receipt, type ServiceName } from "pennydata";
import { privateKeyToAccount } from "viem/accounts";
import { CdpClient } from "@coinbase/cdp-sdk";

const LIVE = "https://pennydatahq.com";
const SELLER = process.env.TEST_SELLER_URL ?? "http://localhost:3300";
const EXAMPLES: Record<ServiceName, string> = {} as Record<ServiceName, string>;

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
}

async function expectError(p: Promise<unknown>, code: string, label: string) {
  try {
    await p;
    check(false, `${label}: no error thrown`);
  } catch (e) {
    check(e instanceof PennyDataError && e.code === code, `${label}: ${e instanceof PennyDataError ? e.code : e} (${(e as Error).message})`);
  }
}

// 1. Live shop, unpaid.
const manifest = await (await fetch(`${LIVE}/.well-known/x402`)).json();
const names = Object.keys(SERVICES) as ServiceName[];
check(manifest.resources.length === names.length, `live manifest has ${manifest.resources.length} resources, library has ${names.length}`);
for (const name of names) {
  const s = SERVICES[name];
  const r = manifest.resources.find((x: any) => x.url === `${LIVE}/api/${s.segment}/{${s.param}}`);
  check(!!r && r.accepts[0].amount === s.priceAtomic && r.accepts[0].network === "eip155:8453", `${name}: route and price ${s.priceUsd} match the live manifest`);
  if (!r) continue;
  EXAMPLES[name] = decodeURIComponent(r.example.split("/").pop());
  const res = await fetch(r.example);
  const header = res.headers.get("PAYMENT-REQUIRED");
  const required = header ? JSON.parse(Buffer.from(header, "base64").toString()) : null;
  check(res.status === 402 && required?.accepts?.[0]?.amount === s.priceAtomic, `${name}: live 402 asks for ${required?.accepts?.[0]?.amount} atomic`);
}

const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
await expectError(
  pennydata({ wallet: buyer, maxPriceUsd: 0.0005 }).fxReferenceRate("USD"),
  "price",
  "live: maxPriceUsd 0.0005 refuses a 0.001 call before signing",
);
await expectError(
  pennydata({ wallet: buyer, network: BASE_SEPOLIA }).fxReferenceRate("USD"),
  "price",
  "live: a client set to Base Sepolia refuses the mainnet 402",
);

// 2. Testnet, paid through the local seller.
async function paidRun(label: string, wallet: Parameters<typeof pennydata>[0]["wallet"], only?: ServiceName[]) {
  const receipts: Receipt[] = [];
  const pd = pennydata({ wallet, baseUrl: SELLER, network: BASE_SEPOLIA, onReceipt: (r) => receipts.push(r) });
  for (const name of only ?? names) {
    // The public testnet facilitator fails a settlement that follows another within about 1 second.
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const data = (await pd[name](EXAMPLES[name])) as Record<string, unknown>;
      const receipt = receipts.find((r) => r.service === name);
      check(
        typeof data === "object" && !!receipt && receipt.amountUsd === SERVICES[name].priceUsd,
        `${label} ${name}(${JSON.stringify(EXAMPLES[name])}): 200, paid ${receipt?.amountUsd} USDC, tx ${receipt?.transaction}`,
      );
    } catch (e) {
      check(false, `${label} ${name}: ${(e as Error).message}`);
    }
  }
  const before = receipts.length;
  await expectError(pd.companyLookup("not a number!"), "bad_input", `${label} 400`);
  await expectError(pd.fxReferenceRate("XXX"), "not_found", `${label} 404`);
  check(receipts.length === before, `${label}: no receipt (no charge) for the 400 and 404`);
  return receipts;
}

const viemReceipts = await paidRun("testnet viem", buyer);

if (process.env.CDP_TEST_ACCOUNT) {
  const cdp = new CdpClient();
  const account = await cdp.evm.getAccount({ name: process.env.CDP_TEST_ACCOUNT });
  const cdpReceipts = await paidRun("testnet CDP", account, ["fxReferenceRate", "countryProfile"]);
  check(cdpReceipts.every((r) => r.payer?.toLowerCase() === account.address.toLowerCase()), `testnet CDP: paid from ${account.address}`);
}

console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} (${viemReceipts.length} viem testnet payments)`);
process.exit(failures ? 1 : 0);
