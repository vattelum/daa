# DAA — Decentralized Autonomous Association

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.31-363636.svg)](https://soliditylang.org)
[![Foundry Tests](https://img.shields.io/badge/Foundry_Tests-113_passing-brightgreen.svg)](https://getfoundry.sh)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-Frontend-FF3E00.svg)](https://kit.svelte.dev)

The Decentralized Autonomous Association (DAA) gives any group of independent persons—whether a blockchain project, an industry body, a standards committee, a professional association, or any other voluntary decentralized collective—a tool to collaboratively create, vote on, and ratify standards and shared principles using blockchain technology.

No single person controls the laws of a DAA registry. Every decision is made through on-chain voting.

Part of the [Vattelum](https://github.com/vattelum) ecosystem.

## Demo

https://github.com/user-attachments/assets/1bf747e9-978a-4c2d-82b7-f28c50b30505

## Why do we need a DAA?

Most blockchain governance tools are built for DAOs, decentralized organizations that pool capital, issue tradable tokens, and share financial risk. While this led to innovations, there are problems with this model.

First, many core DAO activities—raising money from the public, creating monetary instruments, and pooling capital—are regulated activities. As such, regulators cracked down on DAOs.

Second, the DAO concept presupposes the "American startup" as the key form of human organization (raising money in order to build technology). Most human affairs are not governed by startups.

The most important problem of DAOs, however, is that they do not have legal personality. Assets in the real world are governed by laws, not ledger entries. Current DAOs therefore only affect "on-chain" assets and not anything in the real world.

**How is the DAA different?**

The DAA takes a different approach. It specifically is NOT an organization. There are no funds to manage, no financial products, no shared liability, and no regulatory exposure. Because the DAA does not act as an organization, legally, everybody in the DAA is separate.

The DAA is just a governance tool. It allows people from around the world to come together to work on shared laws and principles. Legal force comes from the consent of the participants, either through terms and conditions that create a consensus jurisdiction, or through contracts entered into under laws ratified by the association.

The DAA's core output is its registry, an Ethereum smart contract that records every ratified document with its title, category, version, content hash, and a permanent Arweave link. Documents are organized into categories (e.g., "Governing Laws", "Chain Standards", "Model Agreements") and evolve through a full legislative lifecycle: Originals, Amendments, Revisions, Repeals, and Codifications.

Each document can reference others using typed relationships and section-level targeting, across categories and across chains. As more associations deploy registries, their documents interlink into a cross-chain body of law.

Unlike the [BVS](https://github.com/vattelum/bvs) (Blockchain Voting System), which is run by a single admin who manages membership and records documents, the DAA is fully decentralized. Members mint their own tokens, propose legislation directly, and vote on-chain. Passed proposals execute automatically through a Gnosis Safe. No admin intervention is required. The deployer sets up the infrastructure and hands control to the governance system.

## How It Works

Anyone can fork this repository and deploy their own legislative framework, choosing the categories of law, the approval thresholds for normal and core proposals, the participation quorum, voting duration, minting fee, per-document locked sections, and amendment intervals.

Any person with an Ethereum wallet can mint a soulbound membership token and join an association. However, if you want, you can include additional requirements for membership such as identification tools or a membership fee.

Any token holder can draft legislation in the built-in editor, upload it to permanent storage, and submit it for a vote as an on-chain governance proposal. Members vote For, Against, or Abstain — each vote is an on-chain transaction. When a proposal passes, any wallet can trigger execution, which records the ratified document in the on-chain registry through a Gnosis Safe.

## Blockchain infrastructure

The DAA combines four pieces of blockchain infrastructure:

1. **Membership tokens** — Soulbound (non-transferable) ERC-721 tokens that represent membership. One token per address, self-minted. The token grants voting rights and serves as verifiable on-chain proof of membership.

2. **Permanent storage** — Ratified documents (bylaws, standards, policies) are uploaded to **[Arweave](https://arweave.org)** for permanent storage. Each upload produces a transaction ID that serves as a permanent link to the full text.

3. **On-chain registry** — A smart contract on **Ethereum** records the Arweave transaction ID, a SHA-256 content hash, title, category, document type, version number, and a reference to the governance proposal that approved it. This creates a verifiable index of all ratified legislation.

4. **On-chain governance** — **[Snapshot X](https://snapshotx.xyz)** (sx-evm) handles proposal creation, voting, and execution entirely on-chain. Execution strategies enforce configurable approval thresholds (e.g., 50% for routine proposals, 70% for structural changes), scaling dynamically with membership size. A **Gnosis Safe** sits between the voting system and the registry, executing approved transactions.

The result is a governance system where every decision is recorded, every document is permanent, every vote is on-chain, and the record is independently verifiable.

## Architecture

The DAA is a fully native dApp. The blockchain is the backend. Smart contracts on Ethereum handle membership, document registration, and governance logic.

The frontend is a static SvelteKit application that connects directly to these contracts through the user's existing wallet (MetaMask, Ledger, WalletConnect, etc.). All state lives on-chain or on Arweave. Nothing is stored on a server.

**Smart Contracts** (Solidity 0.8.31, OpenZeppelin 5.x):
- `DAAToken.sol` — ERC-721 + ERC-5192 soulbound membership token with credential storage, open registration, optional minting fee, and `totalSupply()` for governance quorum
- `DAARegistry.sol` — Append-only document registry with categories, document layer, versioning, two-tier governance authority, and per-document amendment restrictions
- `PercentageQuorumAvatarStrategy.sol` — Custom Snapshot X execution strategy with percentage-based approval threshold and participation quorum calculated from `DAAToken.totalSupply()`

**Frontend** (SvelteKit, Tailwind CSS):
- `/` — Public registry browser. Loads categories and documents from the contract, fetches full text from Arweave on demand.
- `/propose` — Structured markdown editor with section numbering, amendment restriction configuration, Arweave upload, and on-chain proposal creation. Token holders only.
- `/admin` — Self-service token minting, member list. Open to anyone.
- `/vote` — Governance page. Active proposals with voting (For/Against/Abstain), passed proposals with execute button, collapsible history. Token holders vote.

**External Services**:
- [Snapshot X](https://snapshotx.xyz) (sx-evm) — On-chain voting and execution
- [Arweave](https://arweave.org) — Permanent document storage via [ArDrive Turbo](https://ardrive.io)
- [Gnosis Safe](https://safe.global) — Governance execution target

**Deployment architecture:**

The system consists of three independent registrations on the blockchain. First, the **membership token** — an ERC-721 contract that issues soulbound credentials and tracks total membership. Second, the **document registry** — an append-only contract that stores the association's legislation, organized by category and document. Third, the **governance environment** — a Snapshot X Space with two execution strategies that route approved proposals through a Gnosis Safe into the registry.

```
DAAToken (soulbound membership, exposes totalSupply())
    └── owner (deployer) — setMintFee(), withdraw(), setVerifier()

DAARegistry (append-only document registry with document layer)
    ├── normalAuthority ─┐
    └── coreAuthority ───┴── Gnosis Safe
                               ├── Module: PercentageQuorumAvatarStrategy (normal, e.g. 50%)
                               └── Module: PercentageQuorumAvatarStrategy (core, e.g. 70%)

Snapshot X Space
    ├── Normal Strategy (e.g. 50% approval, 50% quorum) → Safe → DAARegistry
    └── Core Strategy (e.g. 70% approval, 50% quorum) → Safe → DAARegistry
```

## Quick Start

### Browse the demo

The repository ships with a demo deployment on Sepolia testnet. To see it in action:

1. Clone the repository
2. Copy `.env.example` to `.env` in `apps/frontend/`
3. Run `npm install && npm run dev`
4. Open the app in your browser — the registry loads with the test deployment

To interact (mint, propose, vote), connect a wallet with Sepolia ETH.

### Deploy your own

To create your own DAA, you must deploy new smart contracts and set up the governance infrastructure.

You are free to select your own categories of legislation and voting strategies.

#### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Foundry](https://getfoundry.sh) (for contract compilation, testing, and deployment)
- An Ethereum wallet (MetaMask, Ledger, etc.)

#### 1. Deploy the contracts

The deployment consists of six steps, each depending on addresses from the previous one. The contracts can be deployed to any EVM-compatible network where Snapshot X (sx-evm) and Gnosis Safe are available.

Start by compiling and testing:

```sh
cd apps/contracts
forge install
forge build
forge test
```

Run the six numbered scripts in `script/` in order. Each step depends on addresses from the previous step — update `.env` between runs.

```sh
forge script script/01_Deploy.s.sol --broadcast --rpc-url $SEPOLIA_RPC_URL
```

**`01_Deploy.s.sol` — DAAToken + DAARegistry.** Deploys the core contracts and seeds categories. The deployer (you) becomes the initial `coreAuthority` on the registry. Edit the category names in the script before deploying. After running, set `DAATOKEN_ADDRESS` and `DAAREGISTRY_ADDRESS` in `.env`.

**`02_DeploySafe.s.sol` — Gnosis Safe.** Deploys a Safe with the deployer as sole owner (threshold=1). This Safe becomes the governance gateway through which all approved proposals execute. After running, set `SAFE_ADDRESS` in `.env`.

**`03_CreateVotingSpace.s.sol` — Snapshot X Space.** Creates a voting space via the sx-evm ProxyFactory. Configure voting parameters in the script: voting delay, minimum and maximum voting duration. The Space address must be read from the `ProxyDeployed` event in the transaction receipt. After running, set `SX_SPACE_ADDRESS` in `.env`.

**`04_DeployVotingStrategies.s.sol` — Two execution strategies.** Deploys two instances of `PercentageQuorumAvatarStrategy`, each pointing to the Safe, the Space, and the DAAToken. These are the defaults, but you are free to change them:
- **Normal strategy** — 50% approval threshold, 50% participation quorum (for regular votes)
- **Core strategy** — 70% approval threshold, 50% participation quorum (for core votes, or votes of locked sections)

These percentages are configurable until sealed (see step 7). After running, set `NORMAL_STRATEGY_ADDRESS` and `CORE_STRATEGY_ADDRESS` in `.env`.

**`05_ConnectStrategiesToSafe.s.sol` — Connect strategies to Safe.** Registers both strategy contracts as modules on the Safe. This authorizes them to execute transactions through the Safe when a proposal passes. Without this step, the strategies have no permission to act.

**`06_HandoverToGovernance.s.sol` — Hand over the registry.** Sets `normalAuthority` and `coreAuthority` on the DAARegistry to the Safe address. After this call, the deployer has zero control over the registry. All document additions, category changes, and restriction updates require a governance vote.

**`07_SealStrategies.s.sol` — Seal strategies (optional, irreversible).** Permanently locks all admin functions on both strategy contracts. After sealing, no one can change approval thresholds, participation quorum, voting token, target Safe, or Space whitelist. This step is optional: the deployer may choose to retain the ability to adjust governance parameters. However, until sealed, the deployer can unilaterally alter voting rules. **This cannot be undone.**

After deployment, the deployer retains ownership of the DAAToken (for `setMintFee()`, `withdraw()`, `setVerifier()`).


#### 2. Configure and run frontend

```sh
cd apps/frontend
npm install
cp .env.example .env
```

Edit `.env` with your deployed contract addresses, governance addresses, chain ID, and RPC URL.

```sh
npm run dev
```

### Arweave Setup

The DAA uses [ArDrive Turbo](https://ardrive.io) to upload documents to Arweave. Proposers sign uploads through their connected wallet — no separate Arweave wallet or AR tokens are required.

ArDrive Turbo offers a 100 KiB free tier, which is enough for initial documents. During the development and testing of this project, no payment was required for standard-sized legislation.

If an upload is refused due to size limits:

1. Go to [app.ardrive.io](https://app.ardrive.io) and connect your Ethereum wallet (the same wallet you use to propose legislation)
2. Purchase Turbo credits using ETH — Arweave storage is very cheap (a few cents stores hundreds of kilobytes permanently), so even a small top-up covers many documents

### Test the full flow

1. **Mint a membership token** — Go to Members, click Mint
2. **Draft legislation** — Go to Propose, write the document, select a category and document type
3. **Submit proposal** — The editor uploads to Arweave and creates an on-chain Snapshot X proposal
4. **Vote** — Go to Vote, cast your vote (For / Against / Abstain)
5. **Execute** — After the proposal passes, click Execute on the Vote page
6. **Verify** — The document appears on the homepage under its category

## Configuration

### Contracts `.env`

| Variable | Description |
|---|---|
| `SEPOLIA_RPC_URL` | RPC endpoint for your target network |
| `PRIVATE_KEY` | Deployer wallet private key (see `.env.example` for safer alternatives including hardware wallets and encrypted keystores) |

### Frontend `.env`

| Variable | Description |
|---|---|
| `VITE_DAA_TOKEN_ADDRESS` | Deployed DAAToken contract address |
| `VITE_DAA_REGISTRY_ADDRESS` | Deployed DAARegistry contract address |
| `VITE_CHAIN_ID` | Chain ID of your target network |
| `VITE_DEPLOY_BLOCK` | Block number of contract deployment (for efficient log fetching) |
| `VITE_RPC_URL` | RPC endpoint |
| `VITE_SAFE_ADDRESS` | Gnosis Safe address (governance authority) |
| `VITE_SX_SPACE_ADDRESS` | Snapshot X Space address |
| `VITE_NORMAL_STRATEGY_ADDRESS` | Normal execution strategy (50% approval) |
| `VITE_CORE_STRATEGY_ADDRESS` | Core execution strategy (70% approval) |
| `VITE_AUTHENTICATOR_ADDRESS` | Snapshot X EthTxAuthenticator address |
| `VITE_TERMS_CATEGORY_ID` | Category ID of terms of membership document (optional) |
| `VITE_TERMS_DOCUMENT_ID` | Document ID of terms of membership document (optional) |

## Forward Compatibility

DAA is the third product in the Vattelum ecosystem. The smart contracts include fields that enable the upgrade path to more advanced products (Individual Contracts, SCB):

- **`IVerifier`** — Pluggable verification gate for token minting
- **Amendment restrictions** — Per-document rules for locked sections and time windows
- **External references** — Cross-registry document linking with chain ID and relationship types
- **Document types** — Full legislative lifecycle (Original, Amendment, Revision, Repeal, Codification)

These fields are tested in `ForwardCompat.t.sol` (21 tests) to ensure they store and retrieve correctly.

## License

MIT
