import { sha256 } from 'viem';

export async function hashBody(body: string): Promise<string> {
	const data = new TextEncoder().encode(body.trim());

	// crypto.subtle is only available in secure contexts (HTTPS).
	// Fall back to viem's sha256 on localhost HTTP.
	if (globalThis.crypto?.subtle) {
		const buffer = await crypto.subtle.digest('SHA-256', data);
		const bytes = new Uint8Array(buffer);
		return Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}

	// viem's sha256 accepts a hex-encoded Uint8Array
	const hex = Array.from(data)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return sha256(`0x${hex}`).slice(2); // strip 0x prefix
}

export function hashToBytes32(hex: string): `0x${string}` {
	return `0x${hex}` as `0x${string}`;
}
