/**
 * Snapshot X on-chain governance service.
 *
 * Interacts with sx-evm contracts via viem — no @snapshot-labs/sx SDK.
 * Flow: EthTxAuthenticator.authenticate() → Space.propose/vote
 *       Space.execute() → ExecutionStrategy → Safe → DAARegistry
 */
import { readContract, writeContract, waitForTransactionReceipt } from '@wagmi/core';
import { encodeFunctionData, encodeAbiParameters, parseAbiParameters, decodeAbiParameters, decodeEventLog, decodeFunctionData, type Hex } from 'viem';
import { config, getClient } from '$lib/services/ethereum';
import {
	sxSpaceAddress,
	normalStrategyAddress,
	coreStrategyAddress,
	authenticatorAddress,
	daaTokenAddress,
	daaTokenConfig,
	daaRegistryAddress,
	daaRegistryConfig
} from '$lib/contracts';
import DAARegistryABI from '$lib/contracts/DAARegistry.abi.json';
import { getPaginatedLogs, getCachedProposals, setCachedProposals, type CachedProposalEvent } from '$lib/services/logs';
import { toFunctionSelector } from 'viem';

// --- sx-evm ABIs (minimal, sourced from sx-evm contracts) ---

const spaceAbi = [
	{
		type: 'function',
		name: 'propose',
		inputs: [
			{ name: 'author', type: 'address' },
			{ name: 'metadataURI', type: 'string' },
			{
				name: 'executionStrategy', type: 'tuple',
				components: [
					{ name: 'addr', type: 'address' },
					{ name: 'params', type: 'bytes' }
				]
			},
			{ name: 'userParams', type: 'bytes' }
		],
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'nonpayable'
	},
	{
		type: 'function',
		name: 'vote',
		inputs: [
			{ name: 'voter', type: 'address' },
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'choice', type: 'uint8' },
			{
				name: 'userVotingStrategies', type: 'tuple[]',
				components: [
					{ name: 'index', type: 'uint8' },
					{ name: 'params', type: 'bytes' }
				]
			},
			{ name: 'metadataURI', type: 'string' }
		],
		outputs: [],
		stateMutability: 'nonpayable'
	},
	{
		type: 'function',
		name: 'execute',
		inputs: [
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'payload', type: 'bytes' }
		],
		outputs: [],
		stateMutability: 'nonpayable'
	},
	{
		type: 'function',
		name: 'proposals',
		inputs: [{ name: 'proposalId', type: 'uint256' }],
		outputs: [
			{ name: 'author', type: 'address' },
			{ name: 'startBlockNumber', type: 'uint32' },
			{ name: 'executionStrategy', type: 'address' },
			{ name: 'minEndBlockNumber', type: 'uint32' },
			{ name: 'maxEndBlockNumber', type: 'uint32' },
			{ name: 'finalizationStatus', type: 'uint8' },
			{ name: 'executionPayloadHash', type: 'bytes32' },
			{ name: 'activeVotingStrategies', type: 'uint256' }
		],
		stateMutability: 'view'
	},
	{
		type: 'function',
		name: 'nextProposalId',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'view'
	},
	{
		type: 'function',
		name: 'votePower',
		inputs: [
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'choice', type: 'uint8' }
		],
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'view'
	},
	{
		type: 'function',
		name: 'voteRegistry',
		inputs: [
			{ name: 'proposalId', type: 'uint256' },
			{ name: 'voter', type: 'address' }
		],
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'view'
	},
	{
		type: 'event',
		name: 'ProposalCreated',
		inputs: [
			{ name: 'proposalId', type: 'uint256', indexed: false },
			{ name: 'author', type: 'address', indexed: false },
			{
				name: 'proposal', type: 'tuple', indexed: false,
				components: [
					{ name: 'author', type: 'address' },
					{ name: 'startBlockNumber', type: 'uint32' },
					{ name: 'executionStrategy', type: 'address' },
					{ name: 'minEndBlockNumber', type: 'uint32' },
					{ name: 'maxEndBlockNumber', type: 'uint32' },
					{ name: 'finalizationStatus', type: 'uint8' },
					{ name: 'executionPayloadHash', type: 'bytes32' },
					{ name: 'activeVotingStrategies', type: 'uint256' }
				]
			},
			{ name: 'metadataURI', type: 'string', indexed: false },
			{ name: 'payload', type: 'bytes', indexed: false }
		],
		anonymous: false
	},
	{
		type: 'event',
		name: 'ProposalExecuted',
		inputs: [
			{ name: 'proposalId', type: 'uint256', indexed: true }
		],
		anonymous: false
	}
] as const;

const ethTxAuthenticatorAbi = [
	{
		type: 'function',
		name: 'authenticate',
		inputs: [
			{ name: 'target', type: 'address' },
			{ name: 'functionSelector', type: 'bytes4' },
			{ name: 'data', type: 'bytes' }
		],
		outputs: [],
		stateMutability: 'nonpayable'
	}
] as const;

const executionStrategyAbi = [
	{
		type: 'function',
		name: 'getProposalStatus',
		inputs: [
			{
				name: 'proposal', type: 'tuple',
				components: [
					{ name: 'author', type: 'address' },
					{ name: 'startBlockNumber', type: 'uint32' },
					{ name: 'executionStrategy', type: 'address' },
					{ name: 'minEndBlockNumber', type: 'uint32' },
					{ name: 'maxEndBlockNumber', type: 'uint32' },
					{ name: 'finalizationStatus', type: 'uint8' },
					{ name: 'executionPayloadHash', type: 'bytes32' },
					{ name: 'activeVotingStrategies', type: 'uint256' }
				]
			},
			{ name: 'votesFor', type: 'uint256' },
			{ name: 'votesAgainst', type: 'uint256' },
			{ name: 'votesAbstain', type: 'uint256' }
		],
		outputs: [{ name: '', type: 'uint8' }],
		stateMutability: 'view'
	},
	{
		type: 'function',
		name: 'approvalThreshold',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'view'
	},
	{
		type: 'function',
		name: 'participationQuorum',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'view'
	}
] as const;

// --- Types ---

export enum ProposalStatus {
	VotingDelay = 0,
	VotingPeriod = 1,
	VotingPeriodAccepted = 2,
	Accepted = 3,
	Executed = 4,
	Rejected = 5,
	Cancelled = 6
}

export enum VoteChoice {
	Against = 0,
	For = 1,
	Abstain = 2
}

export interface RestrictionMetadata {
	minTimeBetweenAmendments: number;
	lockedSections: number[];
}

export interface ProposalMetadata {
	title: string;
	categoryId: number;
	documentId: number;
	docType: number;
	arweaveTxId: string;
	contentHash: string;
	restrictions: RestrictionMetadata | null;
}

export interface ProposalInfo {
	proposalId: number;
	startBlockNumber: number;
	minEndBlockNumber: number;
	maxEndBlockNumber: number;
	finalizationStatus: number;
	executionPayloadHash: Hex;
	executionStrategy: string;
	author: string;
	metadataURI: string;
	metadata: ProposalMetadata | null;
	status: ProposalStatus;
	votesFor: bigint;
	votesAgainst: bigint;
	votesAbstain: bigint;
	executionPayload: Hex;
}

interface MetaTransaction {
	to: `0x${string}`;
	value: bigint;
	data: Hex;
	operation: number; // 0 = Call
	salt: bigint;
}

// Function selectors derived from ABI
const PROPOSE_SELECTOR = toFunctionSelector('propose(address,string,(address,bytes),bytes)') as Hex;
const VOTE_SELECTOR = toFunctionSelector('vote(address,uint256,uint8,(uint8,bytes)[],string)') as Hex;

// --- Encoding helpers ---

/**
 * Encode a DAARegistry.addDocument() call as a MetaTransaction for the execution strategy.
 */
export function encodeAddDocumentTransaction(
	input: {
		categoryId: bigint;
		documentId: bigint;
		arweaveTxId: string;
		contentHash: Hex;
		title: string;
		voteId: string;
		docType: number;
	},
	refs: Array<{
		registryAddress: string;
		chainId: bigint;
		categoryId: bigint;
		documentId: bigint;
		version: bigint;
		relationType: number;
		targetSection: string;
	}>
): MetaTransaction {
	const data = encodeFunctionData({
		abi: DAARegistryABI,
		functionName: 'addDocument',
		args: [input, refs]
	});

	return {
		to: daaRegistryAddress,
		value: 0n,
		data,
		operation: 0, // Call
		salt: 0n
	};
}

/**
 * Encode a DAARegistry.setAmendmentRestrictions() call as a MetaTransaction.
 */
export function encodeSetAmendmentRestrictionsTransaction(
	categoryId: bigint,
	documentId: bigint,
	minTimeBetweenAmendments: bigint,
	lockedSections: bigint[]
): MetaTransaction {
	const data = encodeFunctionData({
		abi: DAARegistryABI,
		functionName: 'setAmendmentRestrictions',
		args: [categoryId, documentId, minTimeBetweenAmendments, lockedSections]
	});

	return {
		to: daaRegistryAddress,
		value: 0n,
		data,
		operation: 0,
		salt: 0n
	};
}

/**
 * Encode MetaTransaction[] as execution strategy params.
 */
function encodeExecutionPayload(transactions: MetaTransaction[]): Hex {
	return encodeAbiParameters(
		parseAbiParameters('(address to, uint256 value, bytes data, uint8 operation, uint256 salt)[]'),
		[transactions.map(tx => ({
			to: tx.to,
			value: tx.value,
			data: tx.data,
			operation: tx.operation,
			salt: tx.salt
		}))]
	);
}

// --- Public API ---

/**
 * Create a proposal on Snapshot X via EthTxAuthenticator.
 *
 * @param author - Proposer wallet address
 * @param metadataURI - URI for proposal metadata (e.g. Arweave link)
 * @param strategyAddress - Which execution strategy to use (normal or core)
 * @param transactions - The MetaTransaction(s) to execute if proposal passes
 * @returns proposalId from the ProposalCreated event
 */
export async function createProposal(
	author: `0x${string}`,
	metadataURI: string,
	strategyAddress: `0x${string}`,
	transactions: MetaTransaction[]
): Promise<{ proposalId: number; txHash: string }> {
	const executionPayload = encodeExecutionPayload(transactions);

	// Encode the propose call data for the authenticator
	const proposeData = encodeAbiParameters(
		parseAbiParameters('address, string, (address addr, bytes params), bytes'),
		[
			author,
			metadataURI,
			{ addr: strategyAddress, params: executionPayload },
			'0x' // userParams (empty for VanillaProposalValidation)
		]
	);

	const txHash = await writeContract(config, {
		address: authenticatorAddress,
		abi: ethTxAuthenticatorAbi,
		functionName: 'authenticate',
		args: [sxSpaceAddress, PROPOSE_SELECTOR, proposeData],
		gas: 5_000_000n
	});

	const receipt = await waitForTransactionReceipt(config, { hash: txHash });

	// Extract proposalId from ProposalCreated event
	let proposalId = 0;
	for (const log of receipt.logs) {
		try {
			const decoded = decodeEventLog({
				abi: spaceAbi,
				data: log.data,
				topics: log.topics
			});
			if (decoded.eventName === 'ProposalCreated') {
				proposalId = Number(decoded.args.proposalId);
				break;
			}
		} catch {
			// Not our event, skip
		}
	}

	return { proposalId, txHash };
}

/**
 * Vote on a proposal via EthTxAuthenticator.
 */
export async function vote(
	voter: `0x${string}`,
	proposalId: number,
	choice: VoteChoice
): Promise<string> {
	// Encode the vote call data for the authenticator
	const voteData = encodeAbiParameters(
		parseAbiParameters('address, uint256, uint8, (uint8 index, bytes params)[], string'),
		[
			voter,
			BigInt(proposalId),
			choice,
			[{ index: 0, params: '0x' as Hex }], // VanillaVotingStrategy at index 0
			'' // metadataURI
		]
	);

	const txHash = await writeContract(config, {
		address: authenticatorAddress,
		abi: ethTxAuthenticatorAbi,
		functionName: 'authenticate',
		args: [sxSpaceAddress, VOTE_SELECTOR, voteData],
		gas: 5_000_000n
	});

	await waitForTransactionReceipt(config, { hash: txHash });
	return txHash;
}

/**
 * Execute a passed proposal. Anyone can call this.
 */
export async function execute(
	proposalId: number,
	payload: Hex
): Promise<string> {
	const txHash = await writeContract(config, {
		address: sxSpaceAddress,
		abi: spaceAbi,
		functionName: 'execute',
		args: [BigInt(proposalId), payload],
		gas: 5_000_000n
	});

	await waitForTransactionReceipt(config, { hash: txHash });
	return txHash;
}

/**
 * Decode addDocument metadata (and optional setAmendmentRestrictions) from an execution payload.
 */
function decodeProposalPayload(payload: Hex): ProposalMetadata | null {
	try {
		const [transactions] = decodeAbiParameters(
			parseAbiParameters('(address to, uint256 value, bytes data, uint8 operation, uint256 salt)[]'),
			payload
		);
		if (!transactions || transactions.length === 0) return null;
		const tx = transactions[0];
		const decoded = decodeFunctionData({
			abi: DAARegistryABI,
			data: tx.data
		});
		if (decoded.functionName !== 'addDocument') return null;
		const input = (decoded.args as any[])[0];

		// Check for bundled setAmendmentRestrictions in second transaction
		let restrictions: RestrictionMetadata | null = null;
		if (transactions.length >= 2) {
			try {
				const restrictionTx = transactions[1];
				const restrictionDecoded = decodeFunctionData({
					abi: DAARegistryABI,
					data: restrictionTx.data
				});
				if (restrictionDecoded.functionName === 'setAmendmentRestrictions') {
					const args = restrictionDecoded.args as any[];
					restrictions = {
						minTimeBetweenAmendments: Number(args[2]),
						lockedSections: (args[3] as bigint[]).map(Number)
					};
				}
			} catch {
				// No valid restrictions transaction
			}
		}

		return {
			title: input.title,
			categoryId: Number(input.categoryId),
			documentId: Number(input.documentId),
			docType: Number(input.docType),
			arweaveTxId: input.arweaveTxId,
			contentHash: input.contentHash,
			restrictions
		};
	} catch {
		return null;
	}
}

/**
 * Check if an address has voted on a proposal.
 */
export async function hasVoted(proposalId: number, voter: `0x${string}`): Promise<boolean> {
	const result = (await readContract(config, {
		address: sxSpaceAddress,
		abi: spaceAbi,
		functionName: 'voteRegistry',
		args: [BigInt(proposalId), voter]
	})) as bigint;
	return result > 0n;
}

/**
 * Get total membership count from DAAToken.
 */
export async function getTotalSupply(): Promise<bigint> {
	return (await readContract(config, {
		...daaTokenConfig,
		functionName: 'totalSupply'
	})) as bigint;
}

/**
 * Get full proposal info including status and vote counts.
 */
export async function getProposalInfo(proposalId: number, metadataURI?: string, metadata?: ProposalMetadata | null, executionPayload?: Hex): Promise<ProposalInfo> {
	const proposal = (await readContract(config, {
		address: sxSpaceAddress,
		abi: spaceAbi,
		functionName: 'proposals',
		args: [BigInt(proposalId)]
	})) as [string, number, string, number, number, number, Hex, bigint];

	const [author, startBlockNumber, executionStrategy, minEndBlockNumber,
		maxEndBlockNumber, finalizationStatus, executionPayloadHash, activeVotingStrategies] = proposal;

	// Get vote counts
	const [votesFor, votesAgainst, votesAbstain] = await Promise.all([
		readContract(config, {
			address: sxSpaceAddress,
			abi: spaceAbi,
			functionName: 'votePower',
			args: [BigInt(proposalId), VoteChoice.For]
		}) as Promise<bigint>,
		readContract(config, {
			address: sxSpaceAddress,
			abi: spaceAbi,
			functionName: 'votePower',
			args: [BigInt(proposalId), VoteChoice.Against]
		}) as Promise<bigint>,
		readContract(config, {
			address: sxSpaceAddress,
			abi: spaceAbi,
			functionName: 'votePower',
			args: [BigInt(proposalId), VoteChoice.Abstain]
		}) as Promise<bigint>
	]);

	// Get status from execution strategy
	const proposalStruct = {
		author: author as `0x${string}`,
		startBlockNumber,
		executionStrategy: executionStrategy as `0x${string}`,
		minEndBlockNumber,
		maxEndBlockNumber,
		finalizationStatus,
		executionPayloadHash,
		activeVotingStrategies
	};

	const status = (await readContract(config, {
		address: executionStrategy as `0x${string}`,
		abi: executionStrategyAbi,
		functionName: 'getProposalStatus',
		args: [proposalStruct, votesFor, votesAgainst, votesAbstain]
	})) as number;

	return {
		proposalId,
		startBlockNumber,
		minEndBlockNumber,
		maxEndBlockNumber,
		finalizationStatus,
		executionPayloadHash,
		executionStrategy,
		author,
		metadataURI: metadataURI ?? '',
		metadata: metadata ?? null,
		status: status as ProposalStatus,
		votesFor,
		votesAgainst,
		votesAbstain,
		executionPayload: executionPayload ?? '0x'
	};
}

/**
 * Get all proposals by scanning ProposalCreated events.
 * Extracts metadata from execution payload in each event.
 */
export async function getProposals(): Promise<ProposalInfo[]> {
	const client = getClient();
	if (!client) return [];

	const deployBlock = import.meta.env.VITE_DEPLOY_BLOCK
		? BigInt(import.meta.env.VITE_DEPLOY_BLOCK) : 0n;

	const cached = getCachedProposals();
	const fromBlock = cached ? BigInt(cached.lastBlock) + 1n : deployBlock;

	const proposalCreatedEvent = {
		type: 'event' as const,
		name: 'ProposalCreated' as const,
		inputs: [
			{ name: 'proposalId', type: 'uint256' as const, indexed: false },
			{ name: 'author', type: 'address' as const, indexed: false },
			{
				name: 'proposal', type: 'tuple' as const, indexed: false,
				components: [
					{ name: 'author', type: 'address' as const },
					{ name: 'startBlockNumber', type: 'uint32' as const },
					{ name: 'executionStrategy', type: 'address' as const },
					{ name: 'minEndBlockNumber', type: 'uint32' as const },
					{ name: 'maxEndBlockNumber', type: 'uint32' as const },
					{ name: 'finalizationStatus', type: 'uint8' as const },
					{ name: 'executionPayloadHash', type: 'bytes32' as const },
					{ name: 'activeVotingStrategies', type: 'uint256' as const }
				]
			},
			{ name: 'metadataURI', type: 'string' as const, indexed: false },
			{ name: 'payload', type: 'bytes' as const, indexed: false }
		]
	};

	const result = await getPaginatedLogs(client, {
		address: sxSpaceAddress,
		event: proposalCreatedEvent,
		fromBlock
	}, 'proposals');

	if (!result.complete) {
		console.warn('[proposals] Scan incomplete — showing partial results');
	}

	// Extract new events from scan
	const newEvents: CachedProposalEvent[] = result.logs.map((log: any) => ({
		proposalId: Number(log.args.proposalId),
		metadataURI: log.args.metadataURI ?? '',
		payload: log.args.payload as string
	}));

	// Merge cached + new, deduplicate by proposalId
	const allEvents = [...(cached?.events ?? []), ...newEvents];
	const seen = new Set<number>();
	const uniqueEvents: CachedProposalEvent[] = [];
	for (const ev of allEvents) {
		if (!seen.has(ev.proposalId)) {
			seen.add(ev.proposalId);
			uniqueEvents.push(ev);
		}
	}

	setCachedProposals({
		lastBlock: result.lastScannedBlock.toString(),
		events: uniqueEvents
	});

	// Fetch live status for all proposals
	const proposals: ProposalInfo[] = [];
	for (const ev of uniqueEvents) {
		const metadata = decodeProposalPayload(ev.payload as Hex);
		try {
			const info = await getProposalInfo(ev.proposalId, ev.metadataURI, metadata, ev.payload as Hex);
			proposals.push(info);
		} catch {
			// Skip invalid proposals
		}
	}

	return proposals;
}

/**
 * Get the approval threshold for a strategy.
 */
export async function getApprovalThreshold(strategyAddress: `0x${string}`): Promise<number> {
	const pct = (await readContract(config, {
		address: strategyAddress,
		abi: executionStrategyAbi,
		functionName: 'approvalThreshold'
	})) as bigint;
	return Number(pct);
}

/**
 * Get the participation quorum for a strategy (0 = disabled).
 */
export async function getParticipationQuorum(strategyAddress: `0x${string}`): Promise<number> {
	const pct = (await readContract(config, {
		address: strategyAddress,
		abi: executionStrategyAbi,
		functionName: 'participationQuorum'
	})) as bigint;
	return Number(pct);
}

/**
 * Human-readable status label.
 */
export function statusLabel(status: ProposalStatus): string {
	switch (status) {
		case ProposalStatus.VotingDelay: return 'Pending';
		case ProposalStatus.VotingPeriod: return 'Active';
		case ProposalStatus.VotingPeriodAccepted: return 'Passing';
		case ProposalStatus.Accepted: return 'Passed';
		case ProposalStatus.Executed: return 'Executed';
		case ProposalStatus.Rejected: return 'Rejected';
		case ProposalStatus.Cancelled: return 'Cancelled';
		default: return 'Unknown';
	}
}

/**
 * Determine which strategy to use.
 * Core (70%) when: locked sections are targeted.
 */
export function selectStrategy(touchesLockedSections: boolean): `0x${string}` {
	return touchesLockedSections ? coreStrategyAddress : normalStrategyAddress;
}

/**
 * Get the quorum label for a strategy (e.g. "50%" or "70%").
 */
export function strategyLabel(strategyAddress: string): string {
	if (strategyAddress.toLowerCase() === normalStrategyAddress.toLowerCase()) return 'Normal (50%)';
	if (strategyAddress.toLowerCase() === coreStrategyAddress.toLowerCase()) return 'Core (70%)';
	return 'Unknown';
}
