import { readContract } from '@wagmi/core';
import { config } from '$lib/services/wallet-config';
import { daaRegistryConfig, DAARegistryABI } from '$lib/contracts';
import { fetchFromArweave } from '$lib/services/arweave';
import { stripFrontmatter } from '$lib/services/format';
import { markdownToSections, type Section } from '$lib/services/markdown';
import { parseVariableSchema, type TemplateVariable } from '$lib/services/template-variables';

export interface CategoryInfo {
	id: number;
	name: string;
	documentCount: number;
}

export interface DocumentInfo {
	categoryId: number;
	documentId: number;
	versionCount: number;
	latestTitle: string;
}

export async function loadCategories(): Promise<CategoryInfo[]> {
	const count = (await readContract(config, {
		...daaRegistryConfig,
		functionName: 'categoryCount'
	})) as bigint;

	const cats: CategoryInfo[] = [];
	for (let i = 0n; i < count; i++) {
		const [name, docCount] = await Promise.all([
			readContract(config, {
				...daaRegistryConfig,
				functionName: 'categoryNames',
				args: [i]
			}),
			readContract(config, {
				...daaRegistryConfig,
				functionName: 'getDocumentCount',
				args: [i]
			})
		]);
		cats.push({
			id: Number(i),
			name: name as string,
			documentCount: Number(docCount as bigint)
		});
	}
	return cats;
}

export async function loadDocuments(categoryId: number): Promise<DocumentInfo[]> {
	const docCount = (await readContract(config, {
		...daaRegistryConfig,
		functionName: 'getDocumentCount',
		args: [BigInt(categoryId)]
	})) as bigint;

	const docs: DocumentInfo[] = [];
	for (let i = 1n; i <= docCount; i++) {
		const [versionCount, original] = await Promise.all([
			readContract(config, {
				...daaRegistryConfig,
				functionName: 'getVersionCount',
				args: [BigInt(categoryId), i]
			}) as Promise<bigint>,
			readContract(config, {
				...daaRegistryConfig,
				functionName: 'getDocument',
				args: [BigInt(categoryId), i, 1n]
			}) as Promise<{ title: string }>
		]);
		docs.push({
			categoryId,
			documentId: Number(i),
			versionCount: Number(versionCount),
			latestTitle: original.title
		});
	}
	return docs;
}

export async function getDocumentCount(categoryId: number): Promise<number> {
	const count = (await readContract(config, {
		...daaRegistryConfig,
		functionName: 'getDocumentCount',
		args: [BigInt(categoryId)]
	})) as bigint;
	return Number(count);
}

export interface AmendmentRestrictions {
	minTimeBetweenAmendments: number;
	lastAmendmentTime: number;
	lockedSections: number[];
}

export interface DocumentBody {
	title: string;
	/** Raw markdown with YAML frontmatter stripped, leading whitespace trimmed. */
	body: string;
	/** Parsed sections from `body` (via markdownToSections). */
	sections: Section[];
	/** Template variables declared in the frontmatter (empty when absent). */
	variables: TemplateVariable[];
	contentUri: string;
	contentHash: `0x${string}`;
	docType: number;
}

/**
 * Fetch one document version by (catId, docId, ver) from the given registry
 * (defaults to the local DAARegistry), pull its body from Arweave, strip
 * frontmatter, parse sections, and parse any `variables:` block from the
 * frontmatter.
 *
 * Pass `version` to fetch a specific version via `getDocument`; omit it to
 * fetch the latest via `getLatest`.
 */
export async function loadDocumentBody(
	categoryId: number,
	documentId: number,
	version?: number,
	registryAddress?: `0x${string}`
): Promise<DocumentBody> {
	const cfg = registryAddress
		? ({ address: registryAddress, abi: DAARegistryABI } as const)
		: daaRegistryConfig;

	const raw = version !== undefined
		? (await readContract(config, {
			...cfg,
			functionName: 'getDocument',
			args: [BigInt(categoryId), BigInt(documentId), BigInt(version)]
		})) as { contentUri: string; contentHash: `0x${string}`; title: string; docType: number; version: bigint }
		: (await readContract(config, {
			...cfg,
			functionName: 'getLatest',
			args: [BigInt(categoryId), BigInt(documentId)]
		})) as { contentUri: string; contentHash: `0x${string}`; title: string; docType: number; version: bigint };

	const text = await fetchFromArweave(raw.contentUri, raw.contentHash);
	const body = stripFrontmatter(text);
	return {
		title: raw.title,
		body,
		sections: markdownToSections(body),
		variables: parseVariableSchema(text),
		contentUri: raw.contentUri,
		contentHash: raw.contentHash,
		docType: raw.docType
	};
}

export async function loadAmendmentRestrictions(categoryId: number, documentId: number) {
	const result = (await readContract(config, {
		...daaRegistryConfig,
		functionName: 'getAmendmentRestrictions',
		args: [BigInt(categoryId), BigInt(documentId)]
	})) as [bigint, bigint, bigint[]];

	return {
		minTimeBetweenAmendments: Number(result[0]),
		lastAmendmentTime: Number(result[1]),
		lockedSections: result[2].map(Number)
	};
}
