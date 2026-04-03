export interface Section {
	id: string;
	depth: 1 | 2 | 3;
	title: string;
	content: string;
	/** Original section number override (e.g. "1.1"). When set, the editor displays this instead of computing from position. */
	fixedNumber?: string;
}

let nextId = 0;

export function createSection(depth: 1 | 2 | 3 = 1): Section {
	return { id: `s-${++nextId}`, depth, title: '', content: '' };
}

export function computeSectionNumber(sections: Section[], index: number): string {
	let top = 0;
	let sub = 0;
	let subsub = 0;

	for (let i = 0; i <= index; i++) {
		const d = sections[i].depth;
		if (d === 1) {
			top++;
			sub = 0;
			subsub = 0;
		} else if (d === 2) {
			sub++;
			subsub = 0;
		} else {
			subsub++;
		}
	}

	const d = sections[index].depth;
	if (d === 1) return `§${top}`;
	if (d === 2) return `§${top}.${sub}`;
	return `§${top}.${sub}.${String.fromCharCode(64 + subsub)}`;
}

export function sectionsToMarkdown(sections: Section[]): string {
	return sections
		.map((s, i) => {
			const num = s.fixedNumber ? `§${s.fixedNumber}` : computeSectionNumber(sections, i);
			const hashes = '#'.repeat(s.depth + 1);
			const heading = `${hashes} ${num} ${s.title}`;
			return s.content ? `${heading}\n\n${s.content}` : heading;
		})
		.join('\n\n');
}

export function markdownToSections(markdown: string): Section[] {
	const lines = markdown.split('\n');
	const sections: Section[] = [];
	let current: Section | null = null;
	let contentLines: string[] = [];

	for (const line of lines) {
		const match = line.match(/^(#{2,4})\s+§[\d.A-Z]+\s+(.*)/);
		if (match) {
			if (current) {
				current.content = contentLines.join('\n').trim();
				sections.push(current);
			}
			current = createSection((match[1].length - 1) as 1 | 2 | 3);
			current.title = match[2];
			contentLines = [];
		} else if (current) {
			contentLines.push(line);
		}
	}

	if (current) {
		current.content = contentLines.join('\n').trim();
		sections.push(current);
	}

	return sections;
}

export function buildDocument(frontmatter: Record<string, unknown>, sections: Section[]): string {
	const yaml = Object.entries(frontmatter)
		.map(([k, v]) => {
			if (Array.isArray(v)) {
				const items = v.map((item) => `  - "${item}"`).join('\n');
				return `${k}:\n${items}`;
			}
			if (typeof v === 'string') return `${k}: "${v}"`;
			return `${k}: ${v}`;
		})
		.join('\n');

	const body = sectionsToMarkdown(sections);
	return `---\n${yaml}\n---\n\n${body}\n`;
}

export function parseDocument(text: string): {
	frontmatter: Record<string, string>;
	sections: Section[];
} {
	const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) return { frontmatter: {}, sections: markdownToSections(text) };

	const frontmatter: Record<string, string> = {};
	for (const line of fmMatch[1].split('\n')) {
		const kv = line.match(/^(\w+):\s*"?([^"]*)"?$/);
		if (kv) frontmatter[kv[1]] = kv[2];
	}

	return { frontmatter, sections: markdownToSections(fmMatch[2]) };
}

// ──────────────── Amendment Mode Numbering ────────────────

/**
 * Collect all section numbers from both the original document and the current editor.
 * Used to compute next available numbers when adding sections in amendment mode.
 */
export function collectAllNumbers(editorSections: Section[], originalNumbers: string[]): string[] {
	const fromEditor = editorSections.map(s => s.fixedNumber).filter(Boolean) as string[];
	return [...new Set([...originalNumbers, ...fromEditor])];
}

/**
 * Compute the next available child number under a parent section.
 * e.g. parent "1" with existing children "1.1"–"1.4" → "1.5"
 * e.g. parent "1.1" with no children → "1.1.A"
 */
export function nextChildNumber(
	parentNumber: string,
	parentDepth: 1 | 2 | 3,
	allNumbers: string[]
): { number: string; depth: 1 | 2 | 3 } | null {
	if (parentDepth >= 3) return null; // depth 3 sections can't have children

	if (parentDepth === 1) {
		// Children are "X.N"
		const prefix = parentNumber + '.';
		const childNums = allNumbers
			.filter(n => n.startsWith(prefix) && !n.substring(prefix.length).includes('.'))
			.map(n => parseInt(n.substring(prefix.length)))
			.filter(n => !isNaN(n));
		const next = childNums.length > 0 ? Math.max(...childNums) + 1 : 1;
		return { number: `${parentNumber}.${next}`, depth: 2 };
	} else {
		// parentDepth === 2, children are "X.Y.L" where L is a letter
		const prefix = parentNumber + '.';
		const childLetters = allNumbers
			.filter(n => n.startsWith(prefix))
			.map(n => n.substring(prefix.length))
			.filter(l => l.length === 1 && l >= 'A' && l <= 'Z')
			.map(l => l.charCodeAt(0) - 64); // A=1, B=2
		const next = childLetters.length > 0 ? Math.max(...childLetters) + 1 : 1;
		return { number: `${parentNumber}.${String.fromCharCode(64 + next)}`, depth: 3 };
	}
}

/**
 * Compute the next available sibling number after a given section.
 * e.g. current "1" with siblings "1","2" → "3"
 * e.g. current "1.3" with siblings "1.1"–"1.4" → "1.5"
 */
export function nextSiblingNumber(
	currentNumber: string,
	currentDepth: 1 | 2 | 3,
	allNumbers: string[]
): { number: string; depth: 1 | 2 | 3 } {
	if (currentDepth === 1) {
		const topNums = allNumbers
			.filter(n => !n.includes('.'))
			.map(n => parseInt(n))
			.filter(n => !isNaN(n));
		const next = topNums.length > 0 ? Math.max(...topNums) + 1 : 1;
		return { number: String(next), depth: 1 };
	} else if (currentDepth === 2) {
		const parts = currentNumber.split('.');
		const parent = parts[0];
		const prefix = parent + '.';
		const siblingNums = allNumbers
			.filter(n => n.startsWith(prefix) && !n.substring(prefix.length).includes('.'))
			.map(n => parseInt(n.substring(prefix.length)))
			.filter(n => !isNaN(n));
		const next = siblingNums.length > 0 ? Math.max(...siblingNums) + 1 : 1;
		return { number: `${parent}.${next}`, depth: 2 };
	} else {
		const parts = currentNumber.split('.');
		const parent = `${parts[0]}.${parts[1]}`;
		const prefix = parent + '.';
		const siblingLetters = allNumbers
			.filter(n => n.startsWith(prefix))
			.map(n => n.substring(prefix.length))
			.filter(l => l.length === 1 && l >= 'A' && l <= 'Z')
			.map(l => l.charCodeAt(0) - 64);
		const next = siblingLetters.length > 0 ? Math.max(...siblingLetters) + 1 : 1;
		return { number: `${parent}.${String.fromCharCode(64 + next)}`, depth: 3 };
	}
}

/**
 * Sort sections by their fixedNumber in document order.
 * "1" < "1.1" < "1.1.A" < "1.2" < "2"
 */
export function sortByFixedNumber(sections: Section[]): Section[] {
	return [...sections].sort((a, b) => {
		const an = a.fixedNumber ?? '';
		const bn = b.fixedNumber ?? '';
		return compareSectionNumbers(an, bn);
	});
}

function compareSectionNumbers(a: string, b: string): number {
	const partsA = parseSectionNumber(a);
	const partsB = parseSectionNumber(b);
	for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
		const pa = partsA[i] ?? -1;
		const pb = partsB[i] ?? -1;
		if (pa !== pb) return pa - pb;
	}
	return 0;
}

function parseSectionNumber(num: string): number[] {
	if (!num) return [];
	return num.split('.').map(part => {
		const n = parseInt(part);
		if (!isNaN(n)) return n;
		// Letter: A=1, B=2, etc.
		return part.charCodeAt(0) - 64;
	});
}

/**
 * Post-process rendered HTML to wrap content between headings in
 * indented divs. h2 → depth 1, h3 → depth 2, h4 → depth 3.
 * Each heading and its following content until the next heading
 * get wrapped in a <div class="doc-section-N">.
 */
export function wrapSections(html: string): string {
	// Split on heading tags while keeping them
	const parts = html.split(/(?=<h[234][ >])/);
	return parts.map(part => {
		const match = part.match(/^<h([234])[ >]/);
		if (!match) return part; // content before first heading
		const level = Number(match[1]) - 1; // h2→1, h3→2, h4→3
		return `<div class="doc-section-${level}">${part}</div>`;
	}).join('');
}
