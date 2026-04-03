import { signMessage, sendTransaction, getConnectorClient } from '@wagmi/core';
import { config } from '$lib/services/ethereum';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let turboPromise: Promise<any> | null = null;

async function initTurbo() {
	const client = await getConnectorClient(config);
	if (!client?.account) throw new Error('Wallet not connected');

	const { TurboFactory } = await import('@ardrive/turbo-sdk/web');
	return TurboFactory.authenticated({
		walletAdapter: {
			getSigner: () => ({
				signMessage: (msg: string | Uint8Array) => {
					if (typeof msg === 'string') {
						return signMessage(config, { message: msg });
					}
					return signMessage(config, { message: { raw: msg } });
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				sendTransaction: (tx: any) => sendTransaction(config, tx),
				provider: client.transport
			})
		},
		token: 'ethereum'
	});
}

async function getTurbo() {
	if (!turboPromise) {
		turboPromise = initTurbo();
	}
	return turboPromise;
}

export function resetTurbo() {
	turboPromise = null;
}

export interface UploadCost {
	winc: string;
	bytes: number;
}

export async function getUploadCost(byteCount: number): Promise<UploadCost> {
	const client = await getTurbo();
	const [cost] = await client.getUploadCosts({ bytes: [byteCount] });
	return { winc: cost.winc, bytes: byteCount };
}

export async function getBalance(): Promise<string> {
	const client = await getTurbo();
	const { winc } = await client.getBalance();
	return winc;
}

export async function uploadDocument(content: string): Promise<string> {
	const client = await getTurbo();
	const encoded = new TextEncoder().encode(content);
	const result = await client.upload({
		data: encoded,
		dataItemOpts: {
			tags: [
				{ name: 'Content-Type', value: 'text/markdown; charset=utf-8' },
				{ name: 'App-Name', value: 'Vattelum DAA' }
			]
		}
	});
	return result.id;
}

const GATEWAYS = ['https://arweave.net', 'https://ar-io.dev'];

export function arweaveUrl(txId: string): string {
	return `${GATEWAYS[0]}/${txId}`;
}

const CACHE_PREFIX = 'daa:arweave:';
const CACHE_TS_PREFIX = 'daa:arweave-ts:';

const ARWEAVE_TX_REGEX = /^[A-Za-z0-9_-]{43}$/;

export async function fetchFromArweave(txId: string, contentHash?: string): Promise<string> {
	if (!ARWEAVE_TX_REGEX.test(txId)) {
		throw new Error('Invalid Arweave transaction ID format.');
	}

	// Check localStorage cache by content hash (immutable — never stale)
	if (contentHash) {
		try {
			const cached = localStorage.getItem(CACHE_PREFIX + contentHash);
			if (cached) return cached;
		} catch {
			// storage unavailable
		}
	}

	for (const gateway of GATEWAYS) {
		try {
			const res = await fetch(`${gateway}/${txId}`);
			if (res.ok) {
				const text = await res.text();
				// Cache by content hash — same hash always means same content
				if (contentHash) {
					try {
						localStorage.setItem(CACHE_PREFIX + contentHash, text);
						localStorage.setItem(CACHE_TS_PREFIX + contentHash, String(Date.now()));
					} catch {
						// storage full — evict oldest entries
						evictOldestCache();
						try {
							localStorage.setItem(CACHE_PREFIX + contentHash, text);
							localStorage.setItem(CACHE_TS_PREFIX + contentHash, String(Date.now()));
						} catch {
							// still full, skip caching
						}
					}
				}
				return text;
			}
		} catch {
			// try next gateway
		}
	}
	throw new Error('Document not yet available. It may still be confirming on the Arweave network.');
}

function evictOldestCache() {
	const entries: { key: string; timestamp: number }[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (key?.startsWith(CACHE_PREFIX)) {
			const hash = key.slice(CACHE_PREFIX.length);
			const ts = Number(localStorage.getItem(CACHE_TS_PREFIX + hash)) || 0;
			entries.push({ key, timestamp: ts });
		}
	}
	// Sort oldest first, remove 5
	entries.sort((a, b) => a.timestamp - b.timestamp);
	for (const entry of entries.slice(0, 5)) {
		const hash = entry.key.slice(CACHE_PREFIX.length);
		localStorage.removeItem(entry.key);
		localStorage.removeItem(CACHE_TS_PREFIX + hash);
	}
}
