import { readContract } from '@wagmi/core';
import { config } from '$lib/services/ethereum';
import { daaRegistryConfig } from '$lib/contracts';

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
