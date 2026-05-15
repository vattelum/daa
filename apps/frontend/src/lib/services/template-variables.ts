/**
 * Shared utility for parsing template variable schemas from YAML frontmatter.
 *
 * Templates declare a `variables:` block in their frontmatter listing fields
 * the template renderer should prompt for at instantiation time. Each
 * variable has a name, label, type, and `required` flag. The DAA frontend
 * uses this for the section-target picker (so the picker can preview what
 * inputs a target template will require) and for /vote to display a
 * collapsible variable summary on proposals that target templates.
 */

export interface TemplateVariable {
	name: string;
	label: string;
	type: string;
	required: boolean;
}

/**
 * Parse `variables:` block from document YAML frontmatter.
 * Returns structured variable definitions, or empty array if none found.
 */
export function parseVariableSchema(content: string): TemplateVariable[] {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return [];

	const yamlBlock = fmMatch[1];
	if (!yamlBlock.includes('variables:')) return [];

	// Match the variables block: everything after "variables:" until the next top-level key or end
	const varsMatch = yamlBlock.match(/variables:\n((?:\s+-[\s\S]*?)*)(?=\n\w|\s*$)/);
	if (!varsMatch) return [];

	const entries = varsMatch[1].split(/\n\s*-\s*/).filter(Boolean);

	return entries
		.map((entry) => {
			const nameMatch = entry.match(/name:\s*"?([^"\n,}]+)"?/);
			const labelMatch = entry.match(/label:\s*"?([^"\n,}]+)"?/);
			const typeMatch = entry.match(/type:\s*"?([^"\n,}]+)"?/);
			const reqMatch = entry.match(/required:\s*(true|false)/);

			const name = nameMatch?.[1]?.trim() ?? '';
			// Normalise legacy `type: "string"` (used by older TemplateVarsEditor
			// versions) to the HTML-input-aligned `'text'` so downstream consumers
			// see one canonical value. Existing templates with `"string"` continue
			// to render correctly because VariablesSection's fallback already
			// produces `<input type="text">` for any non-`number` value.
			let type = typeMatch?.[1]?.trim() ?? 'text';
			if (type === 'string') type = 'text';
			return {
				name,
				label: labelMatch?.[1]?.trim() ?? name,
				type,
				required: reqMatch?.[1] === 'true'
			};
		})
		.filter((v) => v.name);
}
