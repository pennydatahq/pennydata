# pennydata

Typed client for [Penny Data](https://pennydatahq.com): pay-per-call data APIs for AI agents. Each call is paid with [x402](https://x402.org) in USDC on Base, from a wallet you pass in. No API key, no account, no subscription.

- 1 import, 1 typed function per service, each returning that service's JSON.
- Pays automatically. Works with any viem account or a CDP server account.
- Never pays more than a service's listed price: if the shop asks for more, or for another network, the call stops before paying.
- You are charged only when data comes back. Bad input (400), not found (404) and upstream errors (502) are free.

## Install

```sh
npm install pennydata
```

Node 20 or later. The package is ESM only.

## Example

```ts
import { pennydata } from "pennydata";
import { privateKeyToAccount } from "viem/accounts";

const pd = pennydata({ wallet: privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`) });

const company = await pd.companyLookup("02366777");
console.log(company.company_name, company.status);

const rate = await pd.fxReferenceRate("GBP");
console.log(`1 EUR = ${rate.rate} GBP on ${rate.date}`);
```

The wallet needs a little USDC on Base (calls cost 0.001 to 0.02 USDC). It does not need ETH: payments are signed, not sent.

### With a CDP wallet

```ts
import { CdpClient } from "@coinbase/cdp-sdk";
import { pennydata } from "pennydata";

const cdp = new CdpClient(); // reads CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET
const pd = pennydata({ wallet: await cdp.evm.getOrCreateAccount({ name: "my-agent" }) });
```

## Services

<!-- services:start -->
| Function | Service | USDC per call | Example input |
|---|---|---|---|
| `companyLookup(number)` | UK Company Lookup | 0.005 | `02366777` |
| `postcodeLookup(postcode)` | UK Postcode Lookup | 0.002 | `SW1A1AA` |
| `filingHistory(number)` | UK Company Filing History | 0.005 | `02366777` |
| `leiLookup(lei)` | LEI Lookup | 0.005 | `RR3QWICWWIPCS8A4S074` |
| `carbonIntensity(postcode)` | GB Carbon Intensity | 0.002 | `RG10` |
| `fxReferenceRate(currency)` | ECB Euro Reference Rate | 0.001 | `USD` |
| `foodHygiene(postcode)` | UK Food Hygiene Ratings | 0.002 | `M11AE` |
| `usCompanyFilings(cik)` | US Company Filings by CIK | 0.003 | `320193` |
| `countryProfile(code)` | Country Profile | 0.003 | `BR` |
| `usWeatherAlerts(state)` | US Weather Alerts | 0.002 | `HI` |
| `companyBrief(number)` | UK Company Brief | 0.02 | `02366777` |
| `auCompanyLookup(acn)` | Australian Company Lookup | 0.003 | `004028077` |
<!-- services:end -->

Prices are fixed per service and are part of this package. Full input and output details: https://pennydatahq.com/docs. Machine-readable: https://pennydatahq.com/openapi.json and https://pennydatahq.com/.well-known/x402.

## Options

| Option | Default | |
|---|---|---|
| `wallet` | (required) | A viem account or CDP server account that holds USDC. |
| `maxPriceUsd` | none | Refuse any single call above this many USDC. |
| `onReceipt` | none | Called after each paid call with `{ service, amountUsd, network, transaction, payer }`. |
| `baseUrl` | `https://pennydatahq.com` | Another Penny Data deployment, for example a local test server. |
| `network` | `eip155:8453` (Base) | `eip155:84532` (Base Sepolia) for a test server. |
| `fetch` | global `fetch` | Your own fetch. |

## Errors

Every failure throws a `PennyDataError` with a `code`:

| Code | Status | Charged? | Meaning |
|---|---|---|---|
| `bad_input` | 400 | No | The value is malformed (the message says what is expected). |
| `not_found` | 404 | No | No such record upstream. |
| `upstream` | 502 | No | The data source did not respond. Try again later. |
| `price` | | No | The shop asked for more than the listed price or another network, so nothing was signed. |
| `payment` | 402 | No | The payment was refused, for example the wallet has too little USDC. |

A `payment` error means the payment was not settled, so nothing was charged and it is safe to call again. The library does not retry by itself.

## Data and licences

Each service names its source and licence in its responses and on https://pennydatahq.com/docs. No service returns personal data about individuals.

## Licence

MIT. See [LICENSE](./LICENSE).
