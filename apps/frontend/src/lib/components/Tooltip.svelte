<script lang="ts">
	let { text, align = 'center', position = 'below', children } = $props<{ text: string; align?: 'center' | 'left' | 'right'; position?: 'below' | 'above'; children: any }>();
</script>

<span class="tooltip-wrap">
	{@render children()}
	<span class="tooltip-text" class:align-left={align === 'left'} class:align-right={align === 'right'} class:above={position === 'above'}>{text}</span>
</span>

<style>
	.tooltip-wrap {
		position: relative;
		display: inline-block;
	}

	.tooltip-text {
		display: none;
		opacity: 0;
		position: absolute;
		left: 50%;
		top: 100%;
		transform: translateX(-50%);
		margin-top: 6px;
		padding: 8px 12px;
		background: var(--color-bg-lighter, #2a2a2e);
		color: var(--color-text, #e0e0e0);
		font-size: 0.75rem;
		line-height: 1.5;
		border-radius: 6px;
		border: 1px solid var(--color-border, #3a3a3e);
		max-width: 380px;
		width: max-content;
		word-wrap: break-word;
		white-space: pre-line;
		z-index: 50;
		transition: opacity 0.15s ease;
		pointer-events: none;
	}

	.tooltip-text.above {
		top: auto;
		bottom: 100%;
		margin-top: 0;
		margin-bottom: 6px;
	}

	.tooltip-text.align-left {
		left: 0;
		transform: none;
	}

	.tooltip-text.align-right {
		left: auto;
		right: 0;
		transform: none;
	}

	.tooltip-wrap:hover .tooltip-text {
		display: block;
		opacity: 1;
	}
</style>
