<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { readContract } from '@wagmi/core';
	import { config } from '$lib/services/ethereum';
	import { daaRegistryConfig, daaRegistryAddress, normalStrategyAddress, coreStrategyAddress } from '$lib/contracts';
	import { wallet } from '$lib/stores/wallet';
	import { loadCategories as fetchCategories, loadDocuments, loadAmendmentRestrictions, getDocumentCount, type CategoryInfo, type DocumentInfo } from '$lib/services/registry';
	import Editor from '$lib/components/Editor.svelte';
	import {
		type Section,
		createSection,
		sectionsToMarkdown,
		buildDocument,
		parseDocument,
		wrapSections
	} from '$lib/services/markdown';
	import { uploadDocument, arweaveUrl } from '$lib/services/arweave';
	import { hashBody, hashToBytes32 } from '$lib/services/hash';
	import {
		DOC_TYPES,
		DOC_TYPE_TO_RELATION,
		docTypeLabel,
		relationLabel,
		requiresReferences,
		allowsMultipleReferences,
		supportsSectionTargeting
	} from '$lib/constants/docTypes';
	import { fetchFromArweave } from '$lib/services/arweave';
	import { computeSectionNumber, markdownToSections, sortByFixedNumber } from '$lib/services/markdown';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import {
		createProposal,
		encodeAddDocumentTransaction,
		encodeSetAmendmentRestrictionsTransaction,
		selectStrategy,
		strategyLabel
	} from '$lib/services/snapshot-x';
	const chainId = Number(import.meta.env.VITE_CHAIN_ID);

	interface VersionInfo {
		version: number;
		title: string;
		docType: number;
	}

	// Form state
	let title = $state('');
	let categoryId = $state(-1);
	let documentId = $state(0); // 0 = new document, >0 = amend existing
	let docType = $state(0);
	let selectedRefs = $state<Array<{ documentId: number; version: number }>>([]);
	let categoryDocuments = $state<DocumentInfo[]>([]);
	let documentVersions = $state<VersionInfo[]>([]);
	let loadingDocuments = $state(false);
	let loadingVersions = $state(false);
	let sections = $state<Section[]>([createSection(1)]);

	// Section targeting
	interface TargetSectionInfo {
		number: string;
		title: string;
		content: string;
		depth: 1 | 2 | 3;
	}
	let selectedTargetSections = $state<string[]>([]);
	let availableTargetSections = $state<TargetSectionInfo[]>([]);
	let allParsedSections = $state<Section[]>([]);
	let newSectionsOnly = $state(false);
	let loadingTargetDoc = $state(false);
	let targetDocError = $state('');
	let targetDocTitle = $state('');

	// Repeal state
	let repealReason = $state('');

	// Amendment restrictions (existing, read from contract)
	let lockedSections = $state<number[]>([]);
	let minTimeBetweenAmendments = $state(0);
	let lastAmendmentTime = $state(0);
	let loadingRestrictions = $state(false);
	let withinInterval = $state(false); // true = within time lock period, routes to 70%
	let nextWindowTime = $state(0);

	// Restriction proposal fields (new, set by proposer)
	let proposeRestrictions = $state(false);
	let proposeTimeLock = $state(0); // seconds; 0 = none
	let proposeTimeLockCustomDays = $state('');
	let proposeTimeLockPreset = $state('permanent'); // 'permanent' | '90' | '180' | '360' | 'custom'
	let proposeLockMode = $state<'entire' | 'specific'>('entire'); // default: entire document
	let proposeLockedSections = $state<number[]>([]); // specific section numbers

	const TIME_LOCK_PRESETS = [
		{ value: 'permanent', label: 'Permanent', seconds: 0 },
		{ value: '90', label: '90 days', seconds: 7_776_000 },
		{ value: '180', label: '180 days', seconds: 15_552_000 },
		{ value: '360', label: '360 days', seconds: 31_104_000 },
		{ value: 'custom', label: 'Custom', seconds: 0 }
	];

	function handleTimeLockPresetChange(preset: string) {
		proposeTimeLockPreset = preset;
		if (preset === 'permanent') {
			proposeTimeLock = 0;
			proposeTimeLockCustomDays = '';
		} else if (preset === 'custom') {
			const days = parseInt(proposeTimeLockCustomDays, 10);
			proposeTimeLock = days > 0 ? days * 86400 : 0;
		} else {
			const found = TIME_LOCK_PRESETS.find(p => p.value === preset);
			if (found) proposeTimeLock = found.seconds;
			proposeTimeLockCustomDays = '';
		}
	}

	function handleCustomDaysChange(value: string) {
		proposeTimeLockCustomDays = value;
		const days = parseInt(value, 10);
		proposeTimeLock = days > 0 ? days * 86400 : 0;
	}

	/** Whether the proposer has set any restrictions */
	function hasProposedRestrictions(): boolean {
		if (!proposeRestrictions) return false;
		return proposeTimeLock > 0 || proposeLockMode === 'entire' || proposeLockedSections.length > 0;
	}

	/** Get the lockedSections array to encode on-chain. [0] = entire document sentinel. */
	function getProposedLockedSections(): bigint[] {
		if (!proposeRestrictions) return [];
		if (proposeLockMode === 'entire') return [0n]; // sentinel for entire document
		return proposeLockedSections.map(s => BigInt(s));
	}

	/** Toggle a specific section number for locking */
	function toggleProposeLockSection(sectionNum: number) {
		if (proposeLockedSections.includes(sectionNum)) {
			proposeLockedSections = proposeLockedSections.filter(s => s !== sectionNum);
		} else {
			proposeLockedSections = [...proposeLockedSections, sectionNum].sort((a, b) => a - b);
		}
	}

	/** Get top-level section numbers from the current editor content */
	function getTopLevelSectionNumbers(): number[] {
		const nums = new Set<number>();
		for (const sec of sections) {
			if (sec.depth === 1 && sec.fixedNumber) {
				const num = parseInt(sec.fixedNumber.split('.')[0], 10);
				if (num > 0) nums.add(num);
			} else if (sec.depth === 1) {
				// For new originals without fixedNumber, use index-based numbering
				nums.add(sections.filter(s => s.depth === 1).indexOf(sec) + 1);
			}
		}
		return [...nums].sort((a, b) => a - b);
	}

	function resetRestrictionFields() {
		proposeRestrictions = false;
		proposeTimeLock = 0;
		proposeTimeLockPreset = 'permanent';
		proposeTimeLockCustomDays = '';
		proposeLockMode = 'entire';
		proposeLockedSections = [];
	}

	/** Whether the proposal touches any locked sections */
	function touchesLockedSections(): boolean {
		if (lockedSections.length === 0) return false;
		if (lockedSections.includes(0)) return true; // sentinel: entire document locked
		if (newSectionsOnly) return false; // adding new sections doesn't target existing locked sections
		if (selectedTargetSections.length === 0) return true; // whole document — touches everything
		return selectedTargetSections.some(sec => {
			const topLevel = parseInt(sec.split('.')[0], 10);
			return lockedSections.includes(topLevel);
		});
	}

	/** Get the strategy address based on whether locked sections are targeted or within interval */
	function getStrategyAddress(): `0x${string}` {
		// Revisions replace the entire document — always core strategy
		if (docType === 2) return selectStrategy(true);
		// Interval only applies when targeting locked sections
		if (touchesLockedSections() && withinInterval) return selectStrategy(true);
		return selectStrategy(touchesLockedSections());
	}

	/** Load amendment restrictions for the selected document */
	async function loadRestrictions(catId: number, docId: number) {
		if (catId < 0 || docId <= 0) {
			lockedSections = [];
			minTimeBetweenAmendments = 0;
			lastAmendmentTime = 0;
			withinInterval = false;
			return;
		}
		loadingRestrictions = true;
		try {
			const restrictions = await loadAmendmentRestrictions(catId, docId);
			lockedSections = restrictions.lockedSections;
			minTimeBetweenAmendments = restrictions.minTimeBetweenAmendments;
			lastAmendmentTime = restrictions.lastAmendmentTime;

			if (minTimeBetweenAmendments > 0 && lastAmendmentTime > 0) {
				const now = Math.floor(Date.now() / 1000);
				const windowOpensAt = lastAmendmentTime + minTimeBetweenAmendments;
				withinInterval = now < windowOpensAt;
				nextWindowTime = windowOpensAt;
			} else {
				withinInterval = false;
				nextWindowTime = 0;
			}
		} catch {
			lockedSections = [];
			minTimeBetweenAmendments = 0;
			lastAmendmentTime = 0;
			withinInterval = false;
		} finally {
			loadingRestrictions = false;
		}
	}

	function targetSectionValue(): string {
		return selectedTargetSections.join(',');
	}

	function titleSuffix(): string {
		if (docType === 3 && selectedTargetSections.length > 0) return 'Partial Repeal';
		return docTypeLabel(docType);
	}

	function baseTitle(t: string): string {
		return t.replace(/\s+v\d+$/, '');
	}

	function revisionTitle(targetTitle: string, targetDocType: number): string {
		if (targetDocType === 2) {
			const match = targetTitle.match(/\s+v(\d+)$/);
			const currentVersion = match ? parseInt(match[1], 10) : 2;
			return `${baseTitle(targetTitle)} v${currentVersion + 1}`;
		}
		return `${baseTitle(targetTitle)} v2`;
	}

	function updateTitle() {
		if (!targetDocTitle) return;
		title = `${targetDocTitle} (${titleSuffix()})`;
	}

	function isImplicitlySelected(sectionNumber: string): boolean {
		return selectedTargetSections.some(sel => {
			if (sel === sectionNumber) return false;
			return sectionNumber.startsWith(sel + '.');
		});
	}

	function sortedSelectedSections(): string[] {
		const order = availableTargetSections.map(s => s.number);
		return [...selectedTargetSections].sort((a, b) => order.indexOf(a) - order.indexOf(b));
	}

	function isAmendmentMode(): boolean {
		return docType === 1;
	}

	function isRepealMode(): boolean {
		return docType === 3 && selectedRefs.length === 1;
	}

	function originalSectionNumbers(): string[] {
		return availableTargetSections.map(s => s.number);
	}

	/** Whether a section number is locked (cascade: locking 1 covers 1.1, 1.2, etc.) */
	function isSectionLocked(sectionNumber: string): boolean {
		if (lockedSections.length === 0) return false;
		if (lockedSections.includes(0)) return true; // sentinel: entire document locked
		const topLevel = parseInt(sectionNumber.split('.')[0], 10);
		return lockedSections.includes(topLevel);
	}

	// Page state
	let categories = $state<CategoryInfo[]>([]);
	let loadingCategories = $state(true);
	let submitting = $state(false);
	let submitStep = $state('');
	let submitError = $state('');
	let importError = $state('');

	// Review modal
	let showReview = $state(false);
	let reviewHtml = $state('');
	let reviewCopyLabel = $state('Copy');

	// Confirmation
	let confirmed = $state(false);
	let confirmData = $state<{
		txHash: string;
		arweaveTxId: string;
		proposalId: number;
		title: string;
		category: string;
		documentId: number;
		docTypeName: string;
		refSummary: string;
		strategy: string;
	} | null>(null);

	function networkName(): string {
		if (chainId === 1) return 'Ethereum';
		if (chainId === 11155111) return 'Sepolia';
		return `Chain ${chainId}`;
	}

	function explorerTxUrl(txHash: string): string {
		if (chainId === 1) return `https://etherscan.io/tx/${txHash}`;
		if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${txHash}`;
		return `https://etherscan.io/tx/${txHash}`;
	}

	function formatDate(): string {
		const d = new Date();
		const months = [
			'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
			'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
		];
		return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
	}

	function formatCountdown(targetTimestamp: number): string {
		const now = Math.floor(Date.now() / 1000);
		const diff = targetTimestamp - now;
		if (diff <= 0) return 'now';
		const days = Math.floor(diff / 86400);
		const hours = Math.floor((diff % 86400) / 3600);
		const mins = Math.floor((diff % 3600) / 60);
		if (days > 0) return `${days}d ${hours}h`;
		if (hours > 0) return `${hours}h ${mins}m`;
		return `${mins}m`;
	}

	async function loadCategories() {
		try {
			categories = await fetchCategories();
		} catch (e) {
			submitError = e instanceof Error ? e.message : 'Failed to load categories';
		} finally {
			loadingCategories = false;
		}
	}

	async function loadDocsForCategory(catId: number) {
		if (catId < 0) {
			categoryDocuments = [];
			return;
		}
		loadingDocuments = true;
		try {
			categoryDocuments = await loadDocuments(catId);
		} catch {
			categoryDocuments = [];
		} finally {
			loadingDocuments = false;
		}
	}

	async function loadVersionsForDocument(catId: number, docId: number) {
		if (catId < 0 || docId <= 0) {
			documentVersions = [];
			return;
		}
		loadingVersions = true;
		try {
			const history = (await readContract(config, {
				...daaRegistryConfig,
				functionName: 'getHistory',
				args: [BigInt(catId), BigInt(docId)]
			})) as Array<{ title: string; version: bigint; docType: number }>;
			documentVersions = history.map((d) => ({
				version: Number(d.version),
				title: d.title,
				docType: d.docType
			}));
		} catch {
			documentVersions = [];
		} finally {
			loadingVersions = false;
		}
	}

	async function loadTargetDocSections(docId: number, version: number) {
		selectedTargetSections = [];
		newSectionsOnly = false;
		availableTargetSections = [];
		allParsedSections = [];
		targetDocError = '';
		targetDocTitle = '';
		if (version <= 0 || categoryId < 0 || docId <= 0) return;

		const ver = documentVersions.find((v) => v.version === version);
		if (!ver) return;

		targetDocTitle = ver.title;
		title = docType === 2 ? revisionTitle(ver.title, ver.docType) : `${ver.title} (${docTypeLabel(docType)})`;

		loadingTargetDoc = true;
		try {
			const doc = (await readContract(config, {
				...daaRegistryConfig,
				functionName: 'getDocument',
				args: [BigInt(categoryId), BigInt(docId), BigInt(version)]
			})) as { arweaveTxId: string; contentHash: string };

			const text = await fetchFromArweave(doc.arweaveTxId, doc.contentHash);
			const bodyMatch = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
			const body = bodyMatch ? bodyMatch[1].trim() : text;

			const parsed = markdownToSections(body);
			if (parsed.length === 0) {
				targetDocError = 'No parseable sections found in the target document.';
				return;
			}

			allParsedSections = parsed;
			availableTargetSections = parsed.map((s, i) => ({
				number: computeSectionNumber(parsed, i).replace('§', ''),
				title: s.title,
				content: s.content,
				depth: s.depth
			}));

			sections = parsed.map((s, i) => {
				const sec = createSection(s.depth);
				sec.title = s.title;
				sec.content = s.content;
				sec.fixedNumber = computeSectionNumber(parsed, i).replace('§', '');
				return sec;
			});
		} catch {
			targetDocError = 'Could not fetch target document. You can still proceed with whole-document mode.';
		} finally {
			loadingTargetDoc = false;
		}
	}

	function handleSectionToggle(sectionNumber: string) {

		const isSelected = selectedTargetSections.includes(sectionNumber);
		if (isSelected) {
			selectedTargetSections = selectedTargetSections.filter(
				(s) => s !== sectionNumber && !s.startsWith(sectionNumber + '.')
			);
		} else {
			if (isImplicitlySelected(sectionNumber)) return;
			const withoutChildren = selectedTargetSections.filter(
				(s) => !s.startsWith(sectionNumber + '.')
			);
			selectedTargetSections = [...withoutChildren, sectionNumber];
		}

		selectedTargetSections = sortedSelectedSections();
		updateTitle();

		if (isRepealMode()) return;

		if (selectedTargetSections.length === 0) {
			sections = allParsedSections.map((s, i) => {
				const sec = createSection(s.depth);
				sec.title = s.title;
				sec.content = s.content;
				sec.fixedNumber = computeSectionNumber(allParsedSections, i).replace('§', '');
				return sec;
			});
		} else {
			const included = availableTargetSections.filter((s) =>
				selectedTargetSections.includes(s.number) || isImplicitlySelected(s.number)
			);
			sections = sortByFixedNumber(included.map((info) => {
				const sec = createSection(info.depth);
				sec.title = info.title;
				sec.content = info.content;
				sec.fixedNumber = info.number;
				return sec;
			}));
		}
	}

	function handleCategoryChange(newCatId: number) {
		categoryId = newCatId;
		documentId = 0;
		selectedRefs = [];
		categoryDocuments = [];
		documentVersions = [];
		selectedTargetSections = [];
		newSectionsOnly = false;
		availableTargetSections = [];
		allParsedSections = [];
		targetDocError = '';
		targetDocTitle = '';
		lockedSections = [];
		minTimeBetweenAmendments = 0;
		lastAmendmentTime = 0;
		withinInterval = false;
		loadDocsForCategory(newCatId);
	}

	function handleDocTypeChange(newDocType: number) {
		const prevDocType = docType;
		docType = newDocType;

		if (newDocType === 0) {
			title = '';
			documentId = 0;
			selectedRefs = [];
			selectedTargetSections = [];
		newSectionsOnly = false;
			availableTargetSections = [];
			allParsedSections = [];
			targetDocError = '';
			targetDocTitle = '';
			repealReason = '';
			documentVersions = [];
			lockedSections = [];
			withinInterval = false;
			sections = [createSection(1)];
			return;
		}

		if (newDocType === 4) {
			title = '';
			selectedRefs = [];
			selectedTargetSections = [];
		newSectionsOnly = false;
			availableTargetSections = [];
			allParsedSections = [];
			targetDocError = '';
			targetDocTitle = '';
			repealReason = '';
			sections = [createSection(1)];
			return;
		}

		if (newDocType === 2 && selectedRefs.length === 1) {
			selectedTargetSections = [];
		newSectionsOnly = false;
			availableTargetSections = [];
			allParsedSections = [];
			repealReason = '';
			if (targetDocTitle) {
				const targetVer = documentVersions.find((v) => v.version === selectedRefs[0].version);
				title = revisionTitle(targetDocTitle, targetVer?.docType ?? 0);
			}
			sections = [createSection(1)];
			return;
		}

		if (supportsSectionTargeting(prevDocType) && supportsSectionTargeting(newDocType) && selectedRefs.length === 1) {
			selectedTargetSections = [];
		newSectionsOnly = false;
			repealReason = '';
			updateTitle();
			sections = allParsedSections.map((s, i) => {
				const sec = createSection(s.depth);
				sec.title = s.title;
				sec.content = s.content;
				sec.fixedNumber = computeSectionNumber(allParsedSections, i).replace('§', '');
				return sec;
			});
			return;
		}

		title = '';
		documentId = 0;
		selectedRefs = [];
		selectedTargetSections = [];
		newSectionsOnly = false;
		availableTargetSections = [];
		allParsedSections = [];
		targetDocError = '';
		targetDocTitle = '';
		repealReason = '';
		documentVersions = [];
		lockedSections = [];
		withinInterval = false;
		sections = [createSection(1)];
	}

	function handleDocumentSelect(docId: number) {
		documentId = docId;
		selectedRefs = [];
		selectedTargetSections = [];
		newSectionsOnly = false;
		availableTargetSections = [];
		allParsedSections = [];
		targetDocError = '';
		targetDocTitle = '';
		documentVersions = [];

		if (docId > 0) {
			loadVersionsForDocument(categoryId, docId);
			loadRestrictions(categoryId, docId);
		} else {
			lockedSections = [];
			withinInterval = false;
		}
	}

	function toggleRef(ref: { documentId: number; version: number }) {
		if (allowsMultipleReferences(docType)) {
			const exists = selectedRefs.find(r => r.documentId === ref.documentId && r.version === ref.version);
			if (exists) {
				selectedRefs = selectedRefs.filter(r => !(r.documentId === ref.documentId && r.version === ref.version));
			} else {
				selectedRefs = [...selectedRefs, ref];
			}
		} else {
			const wasSelected = selectedRefs.find(r => r.documentId === ref.documentId && r.version === ref.version);
			selectedRefs = wasSelected ? [] : [ref];
			selectedTargetSections = [];
		newSectionsOnly = false;
			availableTargetSections = [];
			allParsedSections = [];
			targetDocError = '';
			targetDocTitle = '';
			if (!wasSelected && supportsSectionTargeting(docType)) {
				loadTargetDocSections(ref.documentId, ref.version);
			} else if (!wasSelected) {
				const ver = documentVersions.find((v) => v.version === ref.version);
				if (ver) {
					targetDocTitle = ver.title;
					title = docType === 2 ? revisionTitle(ver.title, ver.docType) : `${ver.title} (${docTypeLabel(docType)})`;
				}
			}
		}
	}

	function isRefSelected(docId: number, version: number): boolean {
		return !!selectedRefs.find(r => r.documentId === docId && r.version === version);
	}

	function buildExternalRefs(): Array<{
		registryAddress: string;
		chainId: bigint;
		categoryId: bigint;
		documentId: bigint;
		version: bigint;
		relationType: number;
		targetSection: string;
	}> {
		if (!requiresReferences(docType) || selectedRefs.length === 0) return [];
		const relationType = DOC_TYPE_TO_RELATION[docType];
		return selectedRefs.map((ref) => ({
			registryAddress: daaRegistryAddress,
			chainId: BigInt(chainId),
			categoryId: BigInt(categoryId),
			documentId: BigInt(ref.documentId),
			version: BigInt(ref.version),
			relationType,
			targetSection: targetSectionValue()
		}));
	}

	// Draft auto-save
	const DRAFT_KEY = 'daa:draft';
	let autoSaveInterval: ReturnType<typeof setInterval> | null = null;

	function saveDraft() {
		if (confirmed) return;
		const hasContent = title.trim() || sections.some(s => s.title.trim() || s.content.trim());
		if (!hasContent) return;
		try {
			localStorage.setItem(DRAFT_KEY, JSON.stringify({
				title, categoryId, documentId, docType, selectedRefs,
				selectedTargetSections, repealReason,
				sections: sections.map(s => ({ depth: s.depth, title: s.title, content: s.content, fixedNumber: s.fixedNumber }))
			}));
		} catch {
			// storage full or unavailable
		}
	}

	function restoreDraft() {
		try {
			const raw = localStorage.getItem(DRAFT_KEY);
			if (!raw) return;
			const draft = JSON.parse(raw);
			title = draft.title ?? '';
			categoryId = draft.categoryId ?? -1;
			documentId = draft.documentId ?? 0;
			docType = draft.docType ?? 0;
			selectedRefs = Array.isArray(draft.selectedRefs) ? draft.selectedRefs : [];
			selectedTargetSections = Array.isArray(draft.selectedTargetSections) ? draft.selectedTargetSections : [];
			repealReason = draft.repealReason ?? '';
			if (categoryId >= 0) loadDocsForCategory(categoryId);
			if (documentId > 0 && categoryId >= 0) {
				loadVersionsForDocument(categoryId, documentId);
				loadRestrictions(categoryId, documentId);
			}
			if (Array.isArray(draft.sections) && draft.sections.length > 0) {
				sections = draft.sections.map((s: { depth: number; title: string; content: string; fixedNumber?: string }) =>
					({ ...createSection(s.depth as 1 | 2 | 3), title: s.title, content: s.content, fixedNumber: s.fixedNumber })
				);
			}
		} catch {
			// corrupt draft, ignore
		}
	}

	function clearDraft() {
		try { localStorage.removeItem(DRAFT_KEY); } catch {}
	}

	function clearAll() {
		if (!confirm('Clear all fields?')) return;
		title = '';
		categoryId = -1;
		documentId = 0;
		docType = 0;
		selectedRefs = [];
		categoryDocuments = [];
		documentVersions = [];
		selectedTargetSections = [];
		newSectionsOnly = false;
		availableTargetSections = [];
		allParsedSections = [];
		targetDocError = '';
		targetDocTitle = '';
		repealReason = '';
		lockedSections = [];
		withinInterval = false;
		sections = [createSection(1)];
		resetRestrictionFields();
		clearDraft();
	}

	function buildRepealBody(): string {
		const sorted = sortedSelectedSections();
		const includesChildren = sorted.some(s => availableTargetSections.some(t => t.number.startsWith(s + '.')));
		const childNote = includesChildren ? ' (and all subsections)' : '';
		let sentence: string;
		if (sorted.length === 0) {
			sentence = `"${targetDocTitle}" is repealed.`;
		} else if (sorted.length === 1) {
			sentence = `\u00A7${sorted[0]}${childNote} of "${targetDocTitle}" is repealed.`;
		} else {
			sentence = `${sorted.map(s => '\u00A7' + s).join(', ')}${childNote} of "${targetDocTitle}" are repealed.`;
		}
		let body = `## Repeal Notice\n\n${sentence}`;
		if (repealReason.trim()) {
			body += `\n\n**Reason:** ${repealReason.trim()}`;
		}
		return body;
	}

	async function openReview() {
		if (!title.trim()) {
			submitError = 'Title is required.';
			return;
		}
		if (title.length > 256) {
			submitError = 'Title must be 256 characters or fewer.';
			return;
		}
		if (categoryId < 0) {
			submitError = 'Please select a category.';
			return;
		}
		if (isRepealMode()) {
			// Repeal doesn't need editor sections
		} else if (sections.length === 0) {
			submitError = 'At least one section is required.';
			return;
		}
		if (proposeRestrictions && proposeLockMode === 'specific' && proposeLockedSections.length === 0) {
			submitError = 'Select at least one section to lock, or switch to "Entire document".';
			return;
		}
		if (requiresReferences(docType) && selectedRefs.length === 0) {
			if (allowsMultipleReferences(docType)) {
				submitError = `${docTypeLabel(docType)} requires selecting at least one document to consolidate.`;
			} else {
				submitError = `Please select a document to ${docTypeLabel(docType).toLowerCase()}.`;
			}
			return;
		}
		submitError = '';

		if (isRepealMode()) {
			const md = buildRepealBody();
			reviewHtml = DOMPurify.sanitize(await marked.parse(md));
		} else {
			const md = sectionsToMarkdown(sections);
			reviewHtml = DOMPurify.sanitize(wrapSections(await marked.parse(md)));
		}
		showReview = true;
	}

	async function handleSubmit() {
		showReview = false;
		submitting = true;
		submitError = '';

		try {
			// 1. Assemble body and compute hash
			submitStep = 'Computing content hash...';
			const body = isRepealMode() ? buildRepealBody() : sectionsToMarkdown(sections);
			const contentHash = await hashBody(body);

			// 2. Build full document with frontmatter
			const cat = categories.find((c) => c.id === categoryId);
			const frontmatter: Record<string, unknown> = {
				title,
				doc_type: docType,
				category: cat?.name ?? '',
				document_id: documentId,
				registry_address: daaRegistryAddress,
				network: networkName(),
				chain_id: chainId,
				submitted: formatDate(),
				content_hash: contentHash,
				...(selectedTargetSections.length > 0 ? { target_section: targetSectionValue() } : {})
			};
			let fullDocument: string;
			if (isRepealMode()) {
				const yaml = Object.entries(frontmatter)
					.map(([k, v]) => typeof v === 'string' ? `${k}: "${v}"` : `${k}: ${v}`)
					.join('\n');
				fullDocument = `---\n${yaml}\n---\n\n${body}\n`;
			} else {
				fullDocument = buildDocument(frontmatter, sections);
			}

			// 3. Upload to Arweave (Transaction 1)
			submitStep = 'Uploading to Arweave...';
			const arweaveTxId = await uploadDocument(fullDocument);

			// 4. Create Snapshot X proposal (Transaction 2)
			submitStep = 'Creating governance proposal...';
			const strategyAddress = getStrategyAddress();

			// Build the MetaTransaction that will execute addDocument() via Safe
			const addDocTx = encodeAddDocumentTransaction(
				{
					categoryId: BigInt(categoryId),
					documentId: BigInt(documentId),
					arweaveTxId,
					contentHash: hashToBytes32(contentHash),
					title,
					voteId: '', // Will be filled by the governance flow
					docType
				},
				buildExternalRefs()
			);

			// Build transaction list — addDocument always, plus optional restrictions
			const transactions = [addDocTx];

			if (hasProposedRestrictions()) {
				// For new documents (documentId=0), pre-compute the documentId
				let restrictionDocId = BigInt(documentId);
				if (documentId === 0) {
					submitStep = 'Computing document ID...';
					const currentCount = await getDocumentCount(categoryId);
					restrictionDocId = BigInt(currentCount + 1);
				}

				const restrictionTx = encodeSetAmendmentRestrictionsTransaction(
					BigInt(categoryId),
					restrictionDocId,
					BigInt(proposeTimeLock),
					getProposedLockedSections()
				);
				transactions.push(restrictionTx);
			}

			// Metadata URI includes Arweave link for voter verification
			const metadataURI = `ipfs://proposal:${title}|arweave:${arweaveTxId}`;

			const result = await createProposal(
				$wallet.address!,
				metadataURI,
				strategyAddress,
				transactions
			);

			// 5. Clear draft and show confirmation
			clearDraft();
			confirmed = true;
			let refSummary = '';
			if (selectedRefs.length > 0 && requiresReferences(docType)) {
				const relType = DOC_TYPE_TO_RELATION[docType];
				const relLabel = relationLabel(relType);
				const ref = selectedRefs[0];
				const refVer = documentVersions.find(v => v.version === ref.version);
				const refTitle = refVer?.title ?? '';
				const secs = selectedTargetSections.length > 0
					? `, \u00A7${sortedSelectedSections().join(', \u00A7')}`
					: '';
				refSummary = `${relLabel} ${refTitle || `document ${ref.documentId}`} v${ref.version}${secs}`;
			}

			confirmData = {
				txHash: result.txHash,
				arweaveTxId,
				proposalId: result.proposalId,
				title,
				category: cat?.name ?? '',
				documentId,
				docTypeName: docTypeLabel(docType),
				refSummary,
				strategy: strategyLabel(strategyAddress)
			};
		} catch (e) {
			submitError = e instanceof Error ? e.message : 'Proposal creation failed';
		} finally {
			submitting = false;
			submitStep = '';
		}
	}

	function handleExport() {
		const cat = categories.find((c) => c.id === categoryId);
		const body = sectionsToMarkdown(sections);
		const frontmatter: Record<string, unknown> = {
			title: title || 'Untitled',
			doc_type: docType,
			category: cat?.name ?? '',
			document_id: documentId,
			registry_address: daaRegistryAddress,
			network: networkName(),
			chain_id: chainId,
			...(selectedTargetSections.length > 0 ? { target_section: targetSectionValue() } : {})
		};
		const doc = buildDocument(frontmatter, sections);

		const blob = new Blob([doc], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(title || 'draft').replace(/\s+/g, '-').toLowerCase()}.md`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function handleImport() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.md';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			importError = '';

			try {
				const text = await file.text();
				const { frontmatter, sections: parsedSections } = parseDocument(text);

				if (parsedSections.length === 0) {
					importError = 'No sections found. Ensure headings use \u00A7-numbered format (## \u00A71, ### \u00A71.1, #### \u00A71.1.A).';
					return;
				}

				if (frontmatter.title && docType !== 1 && docType !== 2 && docType !== 3) title = frontmatter.title;
				if (frontmatter.category) {
					const match = categories.find(
						(c) => c.name.toLowerCase() === frontmatter.category.toLowerCase()
					);
					if (match) categoryId = match.id;
				}

				sections = parsedSections;
			} catch {
				importError = 'Failed to parse the imported file.';
			}
		};
		input.click();
	}

	function resetForm() {
		confirmed = false;
		confirmData = null;
		title = '';
		docType = 0;
		documentId = 0;
		selectedRefs = [];
		categoryDocuments = [];
		documentVersions = [];
		selectedTargetSections = [];
		newSectionsOnly = false;
		availableTargetSections = [];
		allParsedSections = [];
		targetDocError = '';
		targetDocTitle = '';
		repealReason = '';
		lockedSections = [];
		withinInterval = false;
		sections = [createSection(1)];
		resetRestrictionFields();
		clearDraft();
		loadCategories();
	}

	onMount(() => {
		restoreDraft();
		loadCategories();
		autoSaveInterval = setInterval(saveDraft, 30_000);
	});

	onDestroy(() => {
		if (autoSaveInterval) clearInterval(autoSaveInterval);
		saveDraft();
	});
</script>

<div>
	<h1 class="text-2xl font-semibold mb-6">{confirmed ? 'Proposal Submitted' : 'Propose Legislation'}</h1>

	<!-- Confirmation screen -->
	{#if confirmed && confirmData}
		<div class="border border-success/40 rounded-lg p-6">
			<h2 class="text-lg font-medium text-success mb-4">Proposal Created</h2>

			<div class="flex flex-col gap-3 text-sm">
				<div>
					<span class="text-text-muted">Title:</span>
					<span class="ml-2">{confirmData.title}</span>
				</div>
				<div>
					<span class="text-text-muted">Category:</span>
					<span class="ml-2">{confirmData.category}</span>
				</div>
				<div>
					<span class="text-text-muted">Type:</span>
					<span class="ml-2">{confirmData.docTypeName}</span>
				</div>
				<div>
					<span class="text-text-muted">Proposal ID:</span>
					<span class="ml-2 font-mono">{confirmData.proposalId}</span>
				</div>
				<div>
					<span class="text-text-muted">Strategy:</span>
					<span class="ml-2">{confirmData.strategy}</span>
				</div>
				{#if confirmData.refSummary}
					<div>
						<span class="text-text-muted">References:</span>
						<span class="ml-2">{confirmData.refSummary}</span>
					</div>
				{/if}
				<div>
					<span class="text-text-muted">Transaction:</span>
					<a
						href={explorerTxUrl(confirmData.txHash)}
						target="_blank"
						rel="noopener noreferrer"
						class="ml-2 text-primary hover:underline font-mono text-xs"
					>
						{confirmData.txHash.slice(0, 10)}...{confirmData.txHash.slice(-8)}
					</a>
				</div>
				<div>
					<span class="text-text-muted">Arweave:</span>
					<a
						href={arweaveUrl(confirmData.arweaveTxId)}
						target="_blank"
						rel="noopener noreferrer"
						class="ml-2 text-primary hover:underline font-mono text-xs"
					>
						{confirmData.arweaveTxId}
					</a>
				</div>
			</div>

			<p class="text-text-secondary text-sm mt-4">
				Members can now vote on this proposal on the Vote page.
			</p>

			<div class="flex gap-3 mt-6">
				<a
					href="/vote"
					class="text-sm px-4 py-1.5 rounded bg-primary hover:bg-primary-hover text-text transition-colors"
				>
					Vote on the Proposal
				</a>
				<button
					onclick={resetForm}
					class="text-sm px-4 py-1.5 rounded border border-border hover:bg-bg-lighter text-text-secondary transition-colors cursor-pointer"
				>
					Propose Another
				</button>
			</div>
		</div>

	<!-- Editor (accessible to any token holder) -->
	{:else}
		{#if loadingCategories}
			<p class="text-text-secondary">Loading categories...</p>
		{:else}
			{@const canPropose = $wallet.connected && $wallet.isTokenHolder}

			{#if !$wallet.connected}
				<div class="border border-border rounded-lg p-4 text-center mb-6">
					<p class="text-text-muted text-sm">Connect your wallet to propose legislation.</p>
				</div>
			{:else if !$wallet.isTokenHolder}
				<div class="border border-border rounded-lg p-4 text-center mb-6">
					<p class="text-text-muted text-sm">You need a membership token to propose legislation. <a href="/admin" class="text-primary hover:underline">Join the association</a> first.</p>
				</div>
			{/if}

			<div class="flex flex-col gap-5" class:opacity-50={!canPropose} class:pointer-events-none={!canPropose}>
				<!-- Metadata form -->
				<div class="flex flex-col gap-4">
					<div>
						<label for="title" class="block text-sm text-text-secondary mb-1">Title</label>
						<input
							id="title"
							type="text"
							bind:value={title}
							disabled={!canPropose}
							placeholder="Document title"
							class="w-full bg-bg-light border border-border rounded px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
						/>
					</div>

					<div>
						<label for="category" class="block text-sm text-text-secondary mb-1"
							>Category <Tooltip text={"Categories are defined in the smart contract by the governance authority and represent distinct legislative domains (e.g. Governing Laws, Chain Standards, Model Agreements).\n\nNew categories can be added by the core governance authority."} align="left"><span class="text-text-muted cursor-help">(?)</span></Tooltip></label
						>
						<select
							id="category"
							value={categoryId}
							onchange={(e) => handleCategoryChange(Number((e.target as HTMLSelectElement).value))}
							disabled={!canPropose}
							class="w-full bg-bg-light border border-border rounded px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
						>
							<option value={-1} disabled>Select a category</option>
							{#each categories as cat}
								<option value={cat.id}>{cat.name}</option>
							{/each}
						</select>
					</div>

					<div>
						<label for="docType" class="block text-sm text-text-secondary mb-1"
							>Document Type <Tooltip text={"Original: new legislation.\nAmendment: modifies an existing document.\nRevision: full replacement.\nRepeal: revokes a document.\nCodification: consolidates multiple documents."} align="left"><span class="text-text-muted cursor-help">(?)</span></Tooltip></label
						>
						<select
							id="docType"
							value={docType}
							onchange={(e) => handleDocTypeChange(Number((e.target as HTMLSelectElement).value))}
							disabled={!canPropose}
							class="w-full bg-bg-light border border-border rounded px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
						>
							{#each DOC_TYPES as dt}
								<option value={dt.value}>{dt.label}</option>
							{/each}
						</select>
					</div>

					{#if requiresReferences(docType)}
						<!-- Document selector -->
						{#if !allowsMultipleReferences(docType)}
							<div>
								<label class="block text-sm text-text-secondary mb-1">
									Select document to {docTypeLabel(docType).toLowerCase()}
								</label>
								{#if categoryId < 0}
									<p class="text-text-muted text-sm">Select a category first.</p>
								{:else if loadingDocuments}
									<p class="text-text-muted text-sm">Loading documents...</p>
								{:else if categoryDocuments.length === 0}
									<p class="text-text-muted text-sm">No documents in this category.</p>
								{:else}
									<div class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-border rounded p-2">
										{#each categoryDocuments as cdoc}
											<button
												type="button"
												onclick={() => handleDocumentSelect(cdoc.documentId)}
												class="text-left px-3 py-1.5 rounded text-sm transition-colors cursor-pointer
													{documentId === cdoc.documentId ? 'bg-primary/20 border border-primary/40' : 'hover:bg-bg-lighter border border-transparent'}"
											>
												<span class="font-mono text-text-muted mr-2">{cdoc.documentId}.</span>
												{cdoc.latestTitle}
												<span class="text-xs text-text-muted ml-1">({cdoc.versionCount} {cdoc.versionCount === 1 ? 'version' : 'versions'})</span>
											</button>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						<!-- Amendment restrictions info -->
						{#if documentId > 0 && !loadingRestrictions}
							{#if lockedSections.length > 0}
								<div class="border border-border rounded p-3">
									<p class="text-text-secondary text-sm">
										Locked sections: {lockedSections.includes(0) ? 'All' : lockedSections.map(s => '\u00A7' + s).join(', ')}
										<span class="text-text-muted"> — proposals targeting these sections require {strategyLabel(coreStrategyAddress)} approval.</span>
									</p>
									{#if withinInterval}
										<p class="text-cat-gold text-sm mt-1">Amendment interval active — locked sections require {strategyLabel(coreStrategyAddress)} until <span class="font-mono">{formatCountdown(nextWindowTime)}</span>.</p>
									{/if}
								</div>
							{/if}
						{/if}

						<!-- Version selector -->
						{#if (documentId > 0 && !allowsMultipleReferences(docType)) || allowsMultipleReferences(docType)}
							<div>
								<label class="block text-sm text-text-secondary mb-1">
									{allowsMultipleReferences(docType) ? 'Select versions to consolidate' : 'Select version'}
								</label>
								{#if loadingVersions}
									<p class="text-text-muted text-sm">Loading versions...</p>
								{:else if !allowsMultipleReferences(docType) && documentVersions.length === 0}
									<p class="text-text-muted text-sm">No versions found.</p>
								{:else if allowsMultipleReferences(docType) && categoryDocuments.length === 0}
									<p class="text-text-muted text-sm">Select a category first.</p>
								{:else}
									<div class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-border rounded p-2">
										{#if allowsMultipleReferences(docType)}
											{#each categoryDocuments as cdoc}
												<button
													type="button"
													onclick={() => toggleRef({ documentId: cdoc.documentId, version: 1 })}
													class="text-left px-3 py-1.5 rounded text-sm transition-colors cursor-pointer
														{isRefSelected(cdoc.documentId, 1) ? 'bg-primary/20 border border-primary/40' : 'hover:bg-bg-lighter border border-transparent'}"
												>
													<span class="font-mono text-text-muted mr-2">{cdoc.documentId}.</span>
													{cdoc.latestTitle}
												</button>
											{/each}
										{:else}
											{#each documentVersions as ver}
												<button
													type="button"
													onclick={() => toggleRef({ documentId, version: ver.version })}
													class="text-left px-3 py-1.5 rounded text-sm transition-colors cursor-pointer
														{isRefSelected(documentId, ver.version) ? 'bg-primary/20 border border-primary/40' : 'hover:bg-bg-lighter border border-transparent'}"
												>
													<span class="font-mono text-text-muted mr-2">v{ver.version}</span>
													{ver.title}
													<span class="text-xs px-1.5 py-0.5 rounded bg-bg-lighter text-text-muted ml-1">{docTypeLabel(ver.docType)}</span>
												</button>
											{/each}
										{/if}
									</div>
								{/if}
							</div>
						{/if}

						<!-- Section picker (Amendment + Repeal only) -->
						{#if supportsSectionTargeting(docType) && selectedRefs.length === 1}
							<div>
								<label class="block text-sm text-text-secondary mb-1">
									Target sections <span class="text-text-muted">(select specific sections, or leave all unselected for whole document)</span>
								</label>
								{#if loadingTargetDoc}
									<p class="text-text-muted text-sm">Loading document sections...</p>
								{:else if targetDocError}
									<p class="text-text-muted text-sm">{targetDocError}</p>
								{:else if availableTargetSections.length > 0}
									<div class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-border rounded p-2 {newSectionsOnly ? 'opacity-40 pointer-events-none' : ''}">
										{#each availableTargetSections as sec}
											{@const explicit = !newSectionsOnly && selectedTargetSections.includes(sec.number)}
											{@const implicit = !newSectionsOnly && isImplicitlySelected(sec.number)}
											{@const locked = isSectionLocked(sec.number)}
											<button
												type="button"
												onclick={() => handleSectionToggle(sec.number)}
												disabled={newSectionsOnly}
												class="text-left rounded text-sm transition-colors cursor-pointer
													{explicit ? 'bg-primary/20 border border-primary/40' : implicit ? 'bg-primary/10 border border-primary/20 opacity-60' : 'hover:bg-bg-lighter border border-transparent'}"
												style="padding: 6px 12px 6px {12 + (sec.depth - 1) * 16}px"
											>
												<span class="font-mono text-text-muted mr-2">{'\u00A7'}{sec.number}</span>
												{sec.title}
												{#if implicit}<span class="text-xs text-text-muted ml-1">(included)</span>{/if}
												{#if locked}<span class="text-xs text-error ml-1">(locked)</span>{/if}
											</button>
										{/each}
									</div>
									{#if newSectionsOnly}
										<p class="text-xs text-text-muted mt-1">
											Adding new sections only. Use the editor to add clauses.
										</p>
									{:else if selectedTargetSections.length > 0}
										<p class="text-xs text-text-muted mt-1">
											Targeting {sortedSelectedSections().map(s => '\u00A7' + s).join(', ')}{sortedSelectedSections().some(s => availableTargetSections.some(t => t.number.startsWith(s + '.'))) ? ' (and all subsections)' : ''}{isRepealMode() ? '' : ' \u2014 editor loaded with selected sections.'}
										</p>
									{:else}
										<p class="text-xs text-text-muted mt-1">
											All sections loaded. Select specific sections to narrow the scope.
										</p>
									{/if}
									{#if isAmendmentMode()}
										<label class="flex items-center gap-2 cursor-pointer mt-2">
											<input
												type="checkbox"
												bind:checked={newSectionsOnly}
												onchange={() => {
													if (newSectionsOnly) {
														selectedTargetSections = [];
														sections = [];
													} else {
														sections = allParsedSections.map((s, i) => {
															const sec = createSection(s.depth);
															sec.title = s.title;
															sec.content = s.content;
															sec.fixedNumber = computeSectionNumber(allParsedSections, i).replace('§', '');
															return sec;
														});
													}
													updateTitle();
												}}
												class="accent-primary"
											/>
											<span class="text-sm text-text-secondary">Add new section instead</span>
										</label>
									{/if}
								{/if}
							</div>
						{/if}
					{/if}
				</div>

				{#if isRepealMode()}
					<!-- Repeal UI -->
					<div class="border border-border rounded bg-bg-light p-4 flex flex-col gap-4">
						<div>
							<p class="text-sm text-text-secondary">
								{#if selectedTargetSections.length > 0}
									Repealing {sortedSelectedSections().map(s => '\u00A7' + s).join(', ')}{sortedSelectedSections().some(s => availableTargetSections.some(t => t.number.startsWith(s + '.'))) ? ' (and all subsections)' : ''} of "{targetDocTitle}"
								{:else}
									Repealing entire document "{targetDocTitle}"
								{/if}
							</p>
						</div>
						<div>
							<label for="repealReason" class="block text-sm text-text-secondary mb-1">Reason for repeal <span class="text-text-muted">(optional)</span></label>
							<textarea
								id="repealReason"
								bind:value={repealReason}
								placeholder="Explain why this document or section is being repealed..."
								rows="4"
								class="w-full bg-bg border border-border rounded p-2 text-sm text-text placeholder:text-text-muted outline-none focus:border-primary resize-y"
							></textarea>
						</div>
					</div>
				{:else}
					<!-- Import/Export/Clear -->
					{#if canPropose}
						<div class="flex gap-3">
							<button
								onclick={handleImport}
								class="text-sm px-4 py-1.5 rounded border border-primary text-primary hover:bg-primary hover:text-text transition-colors cursor-pointer"
							>
								Import .md
							</button>
							<button
								onclick={handleExport}
								class="text-sm px-4 py-1.5 rounded border border-primary text-primary hover:bg-primary hover:text-text transition-colors cursor-pointer"
							>
								Export .md
							</button>
							<button
								onclick={clearAll}
								class="text-sm px-4 py-1.5 rounded border border-border text-text-muted hover:border-error hover:text-error transition-colors cursor-pointer"
							>
								Clear All
							</button>
						</div>
					{/if}

					{#if importError}
						<p class="text-error text-sm">{importError}</p>
					{/if}

					<!-- Editor -->
					<Editor bind:sections amendmentMode={isAmendmentMode()} originalSectionNumbers={originalSectionNumbers()} />
				{/if}

				<!-- Amendment Restrictions (only for new documents and revisions, not amendments) -->
				{#if canPropose && docType !== 3 && !isAmendmentMode()}
					<div class="border border-border rounded-lg p-4">
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								bind:checked={proposeRestrictions}
								class="accent-primary"
							/>
							<span class="text-sm text-text-secondary">Set amendment restrictions on this document</span>
							<Tooltip text={"Bundle amendment restrictions with this proposal. Restrictions protect the document from frequent or trivial changes.\n\nIncludes time locks (minimum wait between amendments) and section locks (require 70% supermajority to amend).\n\nRestrictions route the proposal to Core strategy (70%)."} align="left"><span class="text-text-muted cursor-help text-xs">(?)</span></Tooltip>
						</label>

						{#if proposeRestrictions}
							<div class="mt-4 flex flex-col gap-4">
								<!-- Locked sections (first) -->
								<div>
									<label class="block text-sm text-text-secondary mb-1">Locked sections <span class="text-text-muted">(require 70% to amend)</span></label>
									<div class="flex items-center gap-4 mb-2">
										<label class="flex items-center gap-1.5 cursor-pointer text-sm">
											<input
												type="radio"
												name="lockMode"
												value="entire"
												checked={proposeLockMode === 'entire'}
												onchange={() => { proposeLockMode = 'entire'; proposeLockedSections = []; }}
												class="accent-primary"
											/>
											Entire document
										</label>
										<label class="flex items-center gap-1.5 cursor-pointer text-sm">
											<input
												type="radio"
												name="lockMode"
												value="specific"
												checked={proposeLockMode === 'specific'}
												onchange={() => proposeLockMode = 'specific'}
												class="accent-primary"
											/>
											Specific sections
										</label>
									</div>
									{#if proposeLockMode === 'specific'}
										{@const topSections = getTopLevelSectionNumbers()}
										{#if topSections.length > 0}
											<div class="flex flex-wrap gap-2">
												{#each topSections as secNum}
													{@const isChecked = proposeLockedSections.includes(secNum)}
													<button
														type="button"
														onclick={() => toggleProposeLockSection(secNum)}
														class="px-3 py-1 rounded text-sm border transition-colors cursor-pointer
															{isChecked ? 'bg-primary/20 border-primary/40 text-text' : 'border-border text-text-muted hover:border-primary/40'}"
													>
														&sect;{secNum}
													</button>
												{/each}
											</div>
											{#if proposeLockedSections.length > 0}
												<p class="text-xs text-text-muted mt-1">Locking {proposeLockedSections.map(s => '\u00A7' + s).join(', ')} (cascade: subsections included)</p>
											{/if}
										{:else}
											<p class="text-xs text-text-muted">Add sections to the editor to select which to lock.</p>
										{/if}
									{:else}
										<p class="text-xs text-text-muted">All sections will require 70% supermajority to amend.</p>
									{/if}
								</div>

								<!-- Duration (second) -->
								<div>
									<label class="block text-sm text-text-secondary mb-1">Duration <span class="text-text-muted">(minimum time between amendments to locked sections)</span></label>
									<div class="flex items-center gap-2">
										<select
											value={proposeTimeLockPreset}
											onchange={(e) => handleTimeLockPresetChange((e.target as HTMLSelectElement).value)}
											class="bg-bg-light border border-border rounded px-3 py-2 text-sm outline-none focus:border-primary"
										>
											{#each TIME_LOCK_PRESETS as preset}
												<option value={preset.value}>{preset.label}</option>
											{/each}
										</select>
										{#if proposeTimeLockPreset === 'custom'}
											<input
												type="number"
												min="1"
												placeholder="Days"
												value={proposeTimeLockCustomDays}
												oninput={(e) => handleCustomDaysChange((e.target as HTMLInputElement).value)}
												class="w-24 bg-bg-light border border-border rounded px-3 py-2 text-sm outline-none focus:border-primary"
											/>
											<span class="text-xs text-text-muted">days</span>
										{/if}
									</div>
									{#if proposeTimeLockPreset === 'permanent'}
										<p class="text-xs text-text-muted mt-1">Locked sections always require 70% supermajority.</p>
									{:else if proposeTimeLock > 0}
										<p class="text-xs text-text-muted mt-1">After an amendment, locked sections require 70% for {Math.round(proposeTimeLock / 86400)} days before returning to 50%.</p>
									{/if}
								</div>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Strategy indicator -->
				{#if documentId > 0}
					<div class="text-xs text-text-muted flex items-center gap-2">
						<span>Voting threshold:</span>
						<span class="font-medium {touchesLockedSections() ? 'text-error' : 'text-text-secondary'}">
							{strategyLabel(getStrategyAddress())}
						</span>
						{#if touchesLockedSections() && withinInterval}
							<span class="text-error">— targets locked sections + within interval</span>
						{:else if touchesLockedSections()}
							<span class="text-error">— targets locked sections</span>
						{/if}
					</div>
				{/if}

				<!-- Submit -->
				{#if submitError}
					<p class="text-error text-sm">{submitError}</p>
				{/if}

				{#if canPropose}
					<div class="flex items-center gap-2">
						<button
							onclick={openReview}
							disabled={submitting}
							class="self-start px-6 py-2 rounded bg-primary hover:bg-primary-hover text-text text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{#if submitting}
								{submitStep}
							{:else}
								Review &amp; Submit Proposal
							{/if}
						</button>
						<Tooltip text={"The document is uploaded to Arweave (permanent storage), then a governance proposal is created on Snapshot X.\n\nMembers vote on-chain. If the proposal passes, anyone can execute it from the homepage, which records the document in the registry via the Gnosis Safe.\n\nTwo transactions: (1) Arweave upload, (2) Snapshot X proposal creation."} align="left" position="above"><span class="text-sm text-text-muted cursor-help">(?)</span></Tooltip>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<!-- Review modal -->
{#if showReview}
	<div
		class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6"
		onkeydown={(e) => { if (e.key === 'Escape') showReview = false; }}
		role="button"
		tabindex="-1"
	>
		<div class="bg-bg border border-border rounded-lg max-w-3xl w-full max-h-[85vh] flex flex-col">
			<div class="flex items-center justify-between px-6 py-4 border-b border-border">
				<h2 class="text-lg font-medium">Review: {title}</h2>
				<button
					onclick={() => showReview = false}
					class="text-text-muted hover:text-text transition-colors cursor-pointer text-lg"
				>&times;</button>
			</div>

			<div class="px-6 py-4 text-sm text-text-secondary border-b border-border flex flex-wrap gap-x-6 gap-y-1">
				<span>Category: {categories.find(c => c.id === categoryId)?.name ?? ''}</span>
				{#if documentId > 0}
					<span>Document: {documentId}</span>
				{/if}
				<span>Type: {docTypeLabel(docType)}</span>
				{#if selectedTargetSections.length > 0}
					<span>Target: {selectedTargetSections.map(s => '\u00A7' + s).join(', ')}</span>
				{/if}
				<span class="{touchesLockedSections() ? 'text-error' : ''}">Strategy: {strategyLabel(getStrategyAddress())}{#if touchesLockedSections() && withinInterval} — targets locked sections + within interval{:else if touchesLockedSections()} — targets locked sections{/if}</span>
				{#if hasProposedRestrictions()}
					<span class="text-cat-gold">Restrictions: {proposeLockMode === 'entire' ? 'Entire document locked' : proposeLockedSections.map(s => '\u00A7' + s).join(', ') + ' locked'}{#if proposeTimeLock > 0}, {Math.round(proposeTimeLock / 86400)}-day interval{:else}, permanent{/if}</span>
				{/if}
			</div>

			<div class="overflow-y-auto px-6 py-6 flex-1">
				<div class="doc-viewer prose prose-invert max-w-none text-sm">
					{@html reviewHtml}
				</div>
			</div>

			<div class="flex items-center justify-between px-6 py-4 border-t border-border">
				<button
					onclick={async () => {
						const md = isRepealMode() ? buildRepealBody() : sectionsToMarkdown(sections);
						try {
							await navigator.clipboard.writeText(md);
							reviewCopyLabel = 'Copied';
							setTimeout(() => reviewCopyLabel = 'Copy', 2000);
						} catch {
							reviewCopyLabel = 'Failed';
							setTimeout(() => reviewCopyLabel = 'Copy', 2000);
						}
					}}
					class="text-sm px-4 py-1.5 rounded border border-primary text-primary hover:bg-primary hover:text-text transition-colors cursor-pointer"
				>
					{reviewCopyLabel}
				</button>
				<div class="flex items-center gap-3">
					<button
						onclick={() => showReview = false}
						class="text-sm px-4 py-1.5 rounded border border-border hover:bg-bg-lighter text-text-secondary transition-colors cursor-pointer"
					>
						Back to Editor
					</button>
					<button
						onclick={handleSubmit}
						class="text-sm px-6 py-1.5 rounded bg-primary hover:bg-primary-hover text-text font-medium transition-colors cursor-pointer"
					>
						Upload &amp; Create Proposal
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
