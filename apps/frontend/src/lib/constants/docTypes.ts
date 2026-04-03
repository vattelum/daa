export const DOC_TYPES = [
	{ value: 0, label: 'Original', description: 'New legislation' },
	{ value: 1, label: 'Amendment', description: 'Modifies an existing document' },
	{ value: 2, label: 'Revision', description: 'Full replacement of an existing document' },
	{ value: 3, label: 'Repeal', description: 'Revokes an existing document' },
	{ value: 4, label: 'Codification', description: 'Consolidates multiple documents' }
] as const;

export const RELATION_TYPES = {
	AMENDS: 0,
	REVISES: 1,
	REPEALS: 2,
	CODIFIES: 3
} as const;

/** Maps docType → the relationType used in ExternalReference */
export const DOC_TYPE_TO_RELATION: Record<number, number> = {
	1: RELATION_TYPES.AMENDS,
	2: RELATION_TYPES.REVISES,
	3: RELATION_TYPES.REPEALS,
	4: RELATION_TYPES.CODIFIES
};

export const RELATION_LABELS: Record<number, string> = {
	[RELATION_TYPES.AMENDS]: 'Amends',
	[RELATION_TYPES.REVISES]: 'Revises',
	[RELATION_TYPES.REPEALS]: 'Repeals',
	[RELATION_TYPES.CODIFIES]: 'Codifies'
};

export function docTypeLabel(docType: number): string {
	return DOC_TYPES.find((d) => d.value === docType)?.label ?? `Type ${docType}`;
}

export function relationLabel(relationType: number): string {
	return RELATION_LABELS[relationType] ?? `Relation ${relationType}`;
}

/** Whether a docType requires selecting referenced documents */
export function requiresReferences(docType: number): boolean {
	return docType >= 1 && docType <= 4;
}

/** Whether a docType allows selecting multiple references (only Codification) */
export function allowsMultipleReferences(docType: number): boolean {
	return docType === 4;
}

/** Whether a docType supports section-level targeting (Amendment, Repeal) */
export function supportsSectionTargeting(docType: number): boolean {
	return docType === 1 || docType === 3;
}
