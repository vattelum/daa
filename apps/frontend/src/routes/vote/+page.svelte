<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { fetchFromArweave, arweaveUrl } from '$lib/services/arweave';
	import { wrapSections } from '$lib/services/markdown';
	import { loadCategories, loadDocuments } from '$lib/services/registry';
	import { wallet } from '$lib/stores/wallet';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { docTypeLabel } from '$lib/constants/docTypes';
	import {
		getProposals,
		getApprovalThreshold,
		getParticipationQuorum,
		getTotalSupply,
		hasVoted as checkHasVoted,
		vote as castVote,
		execute as executeProposal,
		ProposalStatus,
		VoteChoice,
		statusLabel,
		strategyLabel,
		type ProposalInfo,
		type RestrictionMetadata
	} from '$lib/services/snapshot-x';
	import { normalStrategyAddress, coreStrategyAddress } from '$lib/contracts';

	// Sepolia average block time ~12s
	const BLOCK_TIME_SECONDS = 12;

	interface ProposalCard extends ProposalInfo {
		categoryName: string;
		documentLabel: string;
		userVoted: boolean;
		htmlContent: string;
		rawMarkdown: string;
		fetching: boolean;
		fetched: boolean;
	}

	let loading = $state(true);
	let error = $state('');
	let activeProposals = $state<ProposalCard[]>([]);
	let passedProposals = $state<ProposalCard[]>([]);
	let historyProposals = $state<ProposalCard[]>([]);
	let expandedId = $state<number | null>(null);
	let historyExpanded = $state(false);
	let historyLoaded = $state(false);

	let totalSupply = $state(0n);
	let normalApproval = $state(0);
	let coreApproval = $state(0);
	let normalParticipation = $state(0);
	let coreParticipation = $state(0);
	let currentBlock = $state(0);

	let votingId = $state<number | null>(null);
	let voteError = $state('');
	let voteSuccess = $state('');
	let executingId = $state<number | null>(null);
	let executeError = $state('');
	let executeSuccess = $state('');

	let categoryNames = $state<Record<number, string>>({});
	let documentTitles = $state<Record<string, string>>({});
	let tickNow = $state(Date.now());
	let tickInterval: ReturnType<typeof setInterval> | null = null;
	let blockRefreshInterval: ReturnType<typeof setInterval> | null = null;
	let blockFetchedAt = $state(0);

	function truncateAddress(addr: string) {
		return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
	}

	function formatRestrictions(r: RestrictionMetadata): string {
		const isEntire = r.lockedSections.includes(0);
		const hasTimeLock = r.minTimeBetweenAmendments > 0;
		const days = Math.round(r.minTimeBetweenAmendments / 86400);

		const scope = isEntire
			? 'Document locked'
			: r.lockedSections.length > 0
				? `\u00A7${r.lockedSections.join(', \u00A7')} locked`
				: '';

		if (scope && hasTimeLock) return `${scope}, ${days}-day interval`;
		if (scope) return scope;
		if (hasTimeLock) return `${days}-day interval`;
		return '';
	}

	/** Estimated seconds remaining until a given block, calibrated against last block fetch. */
	function secondsUntilBlock(blockNumber: number): number {
		if (currentBlock <= 0) return 0;
		const elapsed = (tickNow - blockFetchedAt) / 1000;
		const blockSeconds = (blockNumber - currentBlock) * BLOCK_TIME_SECONDS;
		return Math.max(0, blockSeconds - elapsed);
	}

	function blockToGMT(blockNumber: number): string {
		if (currentBlock <= 0) return `Block ${blockNumber}`;
		const remaining = secondsUntilBlock(blockNumber);
		const date = new Date(tickNow + remaining * 1000);
		const day = String(date.getUTCDate()).padStart(2, '0');
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const hours = String(date.getUTCHours()).padStart(2, '0');
		const mins = String(date.getUTCMinutes()).padStart(2, '0');
		return `${day} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${hours}:${mins} GMT`;
	}

	function timeRemaining(blockNumber: number): string {
		if (currentBlock <= 0) return '';
		const totalSeconds = secondsUntilBlock(blockNumber);
		if (totalSeconds <= 0) return 'ended';
		const days = Math.floor(totalSeconds / 86400);
		const hours = Math.floor((totalSeconds % 86400) / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = Math.floor(totalSeconds % 60);
		const parts: string[] = [];
		if (days > 0) parts.push(`${days}d`);
		if (hours > 0) parts.push(`${hours}h`);
		if (minutes > 0) parts.push(`${minutes}m`);
		if (days === 0) parts.push(`${seconds}s`);
		if (parts.length === 0) parts.push('0s');
		return parts.join(' ');
	}

	function isPassing(proposal: ProposalCard): boolean {
		const approvalNeeded = approvalVotesNeeded(proposal.executionStrategy);
		const approvalMet = proposal.votesFor >= approvalNeeded && proposal.votesFor > proposal.votesAgainst;
		const quorumNeeded = participationVotesNeeded(proposal.executionStrategy);
		const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
		const quorumMet = quorumNeeded === 0n || totalVotes >= quorumNeeded;
		return approvalMet && quorumMet;
	}

	function votingContext(proposal: ProposalCard): string {
		const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
		const allVoted = totalVotes >= totalSupply && totalSupply > 0n;
		const passing = isPassing(proposal);

		if (allVoted && passing) return 'All members voted — passing';
		if (allVoted && !passing) return 'All members voted — failing';
		if (passing) return 'Quorum reached — passing';
		if (totalVotes > 0n) return 'Voting in progress';
		return 'Awaiting votes';
	}

	function votingContextClass(proposal: ProposalCard): string {
		const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
		const allVoted = totalVotes >= totalSupply && totalSupply > 0n;
		if (isPassing(proposal)) return 'text-success';
		if (allVoted) return 'text-error';
		return 'text-text-secondary';
	}

	function approvalForStrategy(strategyAddress: string): number {
		if (strategyAddress.toLowerCase() === normalStrategyAddress.toLowerCase()) return normalApproval;
		if (strategyAddress.toLowerCase() === coreStrategyAddress.toLowerCase()) return coreApproval;
		return 0;
	}

	function participationForStrategy(strategyAddress: string): number {
		if (strategyAddress.toLowerCase() === normalStrategyAddress.toLowerCase()) return normalParticipation;
		if (strategyAddress.toLowerCase() === coreStrategyAddress.toLowerCase()) return coreParticipation;
		return 0;
	}

	function approvalVotesNeeded(strategyAddress: string): bigint {
		const pct = approvalForStrategy(strategyAddress);
		if (totalSupply === 0n || pct === 0) return 0n;
		return (totalSupply * BigInt(pct) + 99n) / 100n;
	}

	function participationVotesNeeded(strategyAddress: string): bigint {
		const pct = participationForStrategy(strategyAddress);
		if (totalSupply === 0n || pct === 0) return 0n;
		return (totalSupply * BigInt(pct) + 99n) / 100n;
	}

	function buildCard(p: ProposalInfo, voted: boolean): ProposalCard {
		const catName = p.metadata ? (categoryNames[p.metadata.categoryId] ?? `Category ${p.metadata.categoryId}`) : 'Unknown';
		let docLabel = '';
		if (p.metadata) {
			if (p.metadata.documentId === 0) {
				docLabel = `New document in ${catName}`;
			} else {
				const titleKey = `${p.metadata.categoryId}-${p.metadata.documentId}`;
				const docTitle = documentTitles[titleKey];
				docLabel = docTitle
					? `${docTypeLabel(p.metadata.docType)} \u2014 ${catName}, Doc ${p.metadata.documentId}: ${docTitle}`
					: `${docTypeLabel(p.metadata.docType)} \u2014 ${catName}, Doc ${p.metadata.documentId}`;
			}
		}
		return {
			...p,
			categoryName: catName,
			documentLabel: docLabel,
			userVoted: voted,
			htmlContent: '',
			rawMarkdown: '',
			fetching: false,
			fetched: false
		};
	}

	function statusClass(status: ProposalStatus): string {
		switch (status) {
			case ProposalStatus.VotingPeriod: return 'text-success';
			case ProposalStatus.VotingPeriodAccepted: return 'text-cat-blue';
			case ProposalStatus.Accepted: return 'text-cat-gold';
			case ProposalStatus.Executed: return 'text-text-secondary';
			case ProposalStatus.Rejected:
			case ProposalStatus.Cancelled: return 'text-error';
			default: return 'text-text-muted';
		}
	}

	function stripFrontmatter(content: string): string {
		const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
		return match ? match[1].trim() : content;
	}

	async function loadPage() {
		try {
			// Load categories for name mapping
			const cats = await loadCategories();
			const names: Record<number, string> = {};
			for (const c of cats) names[c.id] = c.name;
			categoryNames = names;

			// Load governance data in parallel
			const [allProposals, supply, na, ca, np, cp] = await Promise.all([
				getProposals(),
				getTotalSupply(),
				getApprovalThreshold(normalStrategyAddress),
				getApprovalThreshold(coreStrategyAddress),
				getParticipationQuorum(normalStrategyAddress),
				getParticipationQuorum(coreStrategyAddress)
			]);

			totalSupply = supply;
			normalApproval = na;
			coreApproval = ca;
			normalParticipation = np;
			coreParticipation = cp;

			// Get current block
			const client = (await import('$lib/services/ethereum')).getClient();
			if (client) {
				const block = await client.getBlockNumber();
				currentBlock = Number(block);
				blockFetchedAt = Date.now();
			}

			// Load document titles for amendments (documentId > 0)
			const amendedDocs = new Set<string>();
			for (const p of allProposals) {
				if (p.metadata && p.metadata.documentId > 0) {
					amendedDocs.add(`${p.metadata.categoryId}-${p.metadata.documentId}`);
				}
			}
			if (amendedDocs.size > 0) {
				const titles: Record<string, string> = {};
				for (const key of amendedDocs) {
					const [catId, docId] = key.split('-').map(Number);
					try {
						const docs = await loadDocuments(catId);
						const doc = docs.find(d => d.documentId === docId);
						if (doc) titles[key] = doc.latestTitle;
					} catch { /* skip */ }
				}
				documentTitles = titles;
			}

			// Check voted status for active proposals if wallet connected
			const active = allProposals.filter(p =>
				p.status === ProposalStatus.VotingPeriod ||
				p.status === ProposalStatus.VotingPeriodAccepted ||
				p.status === ProposalStatus.VotingDelay
			);
			const passed = allProposals.filter(p => p.status === ProposalStatus.Accepted);
			const history = allProposals.filter(p =>
				p.status === ProposalStatus.Executed ||
				p.status === ProposalStatus.Rejected ||
				p.status === ProposalStatus.Cancelled
			);

			let votedMap: Record<number, boolean> = {};
			if ($wallet.connected && $wallet.address) {
				const checks = await Promise.all(
					active.map(p => checkHasVoted(p.proposalId, $wallet.address!).catch(() => false))
				);
				active.forEach((p, i) => { votedMap[p.proposalId] = checks[i]; });
			}

			activeProposals = active.map(p => buildCard(p, votedMap[p.proposalId] ?? false));
			passedProposals = passed.map(p => buildCard(p, false));
			historyProposals = history.map(p => buildCard(p, false));
			historyLoaded = true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load proposals';
		} finally {
			loading = false;
		}
	}

	function toggleExpand(proposalId: number) {
		if (expandedId === proposalId) {
			expandedId = null;
			return;
		}
		expandedId = proposalId;
		// Fetch document content if not already loaded
		const card = [...activeProposals, ...passedProposals, ...historyProposals].find(p => p.proposalId === proposalId);
		if (card && !card.fetched && !card.fetching && card.metadata?.arweaveTxId) {
			fetchDocument(proposalId, card.metadata.arweaveTxId);
		}
	}

	async function fetchDocument(proposalId: number, arweaveTxId: string) {
		const updateCard = (list: ProposalCard[], update: Partial<ProposalCard>): ProposalCard[] =>
			list.map(p => p.proposalId === proposalId ? { ...p, ...update } : p);

		activeProposals = updateCard(activeProposals, { fetching: true });
		passedProposals = updateCard(passedProposals, { fetching: true });
		historyProposals = updateCard(historyProposals, { fetching: true });

		try {
			const card = [...activeProposals, ...passedProposals, ...historyProposals].find(p => p.proposalId === proposalId);
			const contentHash = card?.metadata?.contentHash ?? '';
			const text = await fetchFromArweave(arweaveTxId, contentHash);
			const body = stripFrontmatter(text);
			const html = DOMPurify.sanitize(wrapSections(await marked.parse(body)));
			const update = { rawMarkdown: body, htmlContent: html, fetching: false, fetched: true };
			activeProposals = updateCard(activeProposals, update);
			passedProposals = updateCard(passedProposals, update);
			historyProposals = updateCard(historyProposals, update);
		} catch {
			const update = {
				htmlContent: '<p class="text-text-muted">Content unavailable. The document may still be confirming on Arweave.</p>',
				fetching: false,
				fetched: true
			};
			activeProposals = updateCard(activeProposals, update);
			passedProposals = updateCard(passedProposals, update);
			historyProposals = updateCard(historyProposals, update);
		}
	}

	async function handleVote(proposalId: number, choice: VoteChoice) {
		if (!$wallet.address) return;
		votingId = proposalId;
		voteError = '';
		voteSuccess = '';

		try {
			await castVote($wallet.address, proposalId, choice);
			voteSuccess = `Vote recorded on proposal #${proposalId}.`;
			// Update card state
			activeProposals = activeProposals.map(p =>
				p.proposalId === proposalId ? { ...p, userVoted: true } : p
			);
			// Refresh vote counts
			await loadPage();
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Vote failed';
			if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('denied')) {
				voteError = 'Transaction was rejected in wallet.';
			} else if (msg.toLowerCase().includes('already voted')) {
				voteError = 'You have already voted on this proposal.';
				activeProposals = activeProposals.map(p =>
					p.proposalId === proposalId ? { ...p, userVoted: true } : p
				);
			} else {
				voteError = msg;
			}
		} finally {
			votingId = null;
		}
	}

	async function handleExecute(proposal: ProposalCard) {
		if (proposal.status !== ProposalStatus.Accepted) return;
		executingId = proposal.proposalId;
		executeError = '';
		executeSuccess = '';

		try {
			const txHash = await executeProposal(proposal.proposalId, proposal.executionPayload);
			executeSuccess = `Proposal #${proposal.proposalId} executed. Tx: ${txHash.slice(0, 10)}...`;
			await loadPage();
		} catch (e) {
			executeError = e instanceof Error ? e.message : 'Execution failed';
		} finally {
			executingId = null;
		}
	}

	function tallyBar(votesFor: bigint, votesAgainst: bigint, votesAbstain: bigint): { forPct: number; againstPct: number; abstainPct: number } {
		const total = votesFor + votesAgainst + votesAbstain;
		if (total === 0n) return { forPct: 0, againstPct: 0, abstainPct: 0 };
		return {
			forPct: Number((votesFor * 100n) / total),
			againstPct: Number((votesAgainst * 100n) / total),
			abstainPct: Number((votesAbstain * 100n) / total)
		};
	}

	onMount(() => {
		loadPage();
		// Live countdown — tick every second
		tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);
		// Refresh block number every 12s to recalibrate
		blockRefreshInterval = setInterval(async () => {
			try {
				const client = (await import('$lib/services/ethereum')).getClient();
				if (client) {
					const prevBlock = currentBlock;
					const block = await client.getBlockNumber();
					currentBlock = Number(block);
					blockFetchedAt = Date.now();
					// Re-fetch proposals when any active proposal's voting period has ended
					if (activeProposals.length > 0 && prevBlock > 0) {
						const anyEnded = activeProposals.some(p => currentBlock >= p.maxEndBlockNumber);
						if (anyEnded) loadPage();
					}
				}
			} catch { /* skip */ }
		}, 12_000);
	});

	onDestroy(() => {
		if (tickInterval) clearInterval(tickInterval);
		if (blockRefreshInterval) clearInterval(blockRefreshInterval);
	});
</script>

<div>
	<h1 class="text-2xl font-semibold mb-6">Governance <Tooltip text={"View active proposals, cast your vote, and execute passed legislation. All voting happens on-chain via Snapshot X. Each vote is a transaction — voters pay gas."} align="left"><span class="text-sm font-normal text-text-muted cursor-help">(?)</span></Tooltip></h1>

	{#if loading}
		<p class="text-text-secondary">Loading proposals...</p>
	{:else if error}
		<p class="text-error">{error}</p>
	{:else}
		<!-- Global messages -->
		{#if voteSuccess}
			<div class="mb-4 px-4 py-2 rounded border border-success/30 bg-success/10">
				<p class="text-success text-sm">{voteSuccess}</p>
			</div>
		{/if}
		{#if voteError}
			<div class="mb-4 px-4 py-2 rounded border border-error/30 bg-error/10 overflow-hidden">
				<p class="text-error text-sm break-all">{voteError}</p>
			</div>
		{/if}
		{#if executeSuccess}
			<div class="mb-4 px-4 py-2 rounded border border-success/30 bg-success/10">
				<p class="text-success text-sm">{executeSuccess}</p>
			</div>
		{/if}
		{#if executeError}
			<div class="mb-4 px-4 py-2 rounded border border-error/30 bg-error/10 overflow-hidden">
				<p class="text-error text-sm break-all">{executeError}</p>
			</div>
		{/if}

		<!-- Active Proposals -->
		<section class="mb-8">
			<h2 class="text-lg font-medium mb-4">Active Proposals <Tooltip text={"Proposals currently open for voting. Each member casts one vote (For, Against, or Abstain) per proposal. Voting is on-chain — each vote is a transaction."} align="left"><span class="text-sm font-normal text-text-muted cursor-help">(?)</span></Tooltip></h2>
			{#if activeProposals.length === 0}
				<p class="text-text-muted text-sm">No active proposals.</p>
			{:else}
				<div class="flex flex-col gap-4">
					{#each activeProposals as proposal}
						{@const tally = tallyBar(proposal.votesFor, proposal.votesAgainst, proposal.votesAbstain)}
						{@const approvalNeeded = approvalVotesNeeded(proposal.executionStrategy)}
						{@const quorumNeeded = participationVotesNeeded(proposal.executionStrategy)}
						{@const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain}
						{@const isExpanded = expandedId === proposal.proposalId}

						<div class="border border-border rounded-lg bg-bg-light">
							<!-- Card header — always visible -->
							<div class="px-5 py-4">
								<div class="flex items-start justify-between gap-4 mb-3">
									<div>
										<div class="flex items-center gap-2 mb-1">
											<span class="font-mono text-text-muted text-xs">#{proposal.proposalId}</span>
											<span class="text-sm font-medium {statusClass(proposal.status)}">{statusLabel(proposal.status)}</span>
											<span class="text-xs {votingContextClass(proposal)}">{votingContext(proposal)}</span>
											<span class="text-xs text-text-muted">{strategyLabel(proposal.executionStrategy)}</span>
										</div>
										<h3 class="text-base font-medium">{proposal.metadata?.title ?? `Proposal #${proposal.proposalId}`}</h3>
										{#if proposal.documentLabel}
											<div class="flex items-center gap-3 mt-1">
												<span class="text-xs text-text-muted">{proposal.documentLabel}</span>
											</div>
										{/if}
										{#if proposal.metadata?.restrictions}
											<div class="flex items-center gap-1 mt-1">
												<span class="text-xs text-cat-gold">Restrictions: {formatRestrictions(proposal.metadata.restrictions)}</span>
											</div>
										{/if}
									</div>
								</div>

								<!-- Vote tally bar -->
								<div class="mt-3">
									<div class="flex h-2 rounded-full overflow-hidden bg-bg-lighter">
										{#if tally.forPct > 0}
											<div class="bg-success" style="width: {tally.forPct}%"></div>
										{/if}
										{#if tally.againstPct > 0}
											<div class="bg-error" style="width: {tally.againstPct}%"></div>
										{/if}
										{#if tally.abstainPct > 0}
											<div class="bg-text-muted" style="width: {tally.abstainPct}%"></div>
										{/if}
									</div>
									<div class="flex items-center justify-between mt-2 text-xs">
										<div class="flex gap-4">
											<span class="text-success">For: {Number(proposal.votesFor)}</span>
											<span class="text-error">Against: {Number(proposal.votesAgainst)}</span>
											<span class="text-text-muted">Abstain: {Number(proposal.votesAbstain)}</span>
										</div>
										<span class="text-text-muted">
											Approval: {Number(proposal.votesFor)}/{Number(approvalNeeded)} needed{#if quorumNeeded > 0n} · Quorum: {Number(totalVotes)}/{Number(quorumNeeded)} voted{/if}
										</span>
									</div>
								</div>

								<!-- Timing -->
								<div class="flex items-center gap-4 mt-2 text-xs text-text-muted">
									<span>Author: {truncateAddress(proposal.author)}</span>
									<span>Ends in: {timeRemaining(proposal.maxEndBlockNumber)} ({blockToGMT(proposal.maxEndBlockNumber)})</span>
								</div>

								<!-- Voting controls — always visible on card -->
								{#if proposal.status === ProposalStatus.VotingPeriod || proposal.status === ProposalStatus.VotingPeriodAccepted}
									<div class="mt-4 pt-3 border-t border-border">
										{#if !$wallet.connected}
											<p class="text-text-muted text-sm">Connect your wallet to vote.</p>
										{:else if !$wallet.isTokenHolder}
											<p class="text-text-muted text-sm">
												<a href="/admin" class="text-primary hover:underline">Join the association</a> to vote.
											</p>
										{:else if proposal.userVoted}
											<p class="text-text-secondary text-sm">You have voted on this proposal.</p>
										{:else}
											<div class="flex items-center gap-3">
												<span class="text-sm text-text-secondary mr-2">Cast your vote:</span>
												<button
													onclick={() => handleVote(proposal.proposalId, VoteChoice.For)}
													disabled={votingId !== null}
													class="px-4 py-1.5 rounded text-sm font-medium bg-success/20 text-success hover:bg-success/30 transition-colors cursor-pointer disabled:opacity-50"
												>
													{votingId === proposal.proposalId ? 'Voting...' : 'For'}
												</button>
												<button
													onclick={() => handleVote(proposal.proposalId, VoteChoice.Against)}
													disabled={votingId !== null}
													class="px-4 py-1.5 rounded text-sm font-medium bg-error/20 text-error hover:bg-error/30 transition-colors cursor-pointer disabled:opacity-50"
												>
													Against
												</button>
												<button
													onclick={() => handleVote(proposal.proposalId, VoteChoice.Abstain)}
													disabled={votingId !== null}
													class="px-4 py-1.5 rounded text-sm font-medium bg-bg-lighter text-text-muted hover:bg-border transition-colors cursor-pointer disabled:opacity-50"
												>
													Abstain
												</button>
											</div>
										{/if}
									</div>
								{/if}
							</div>

							<!-- Document fold — click to expand/collapse -->
							<div class="border-t border-border">
								<button
									onclick={() => toggleExpand(proposal.proposalId)}
									class="w-full text-left px-5 py-2 cursor-pointer flex items-center gap-2 text-xs text-text-muted hover:text-text-secondary transition-colors"
								>
									<span class="transition-transform {isExpanded ? 'rotate-180' : ''}">&#9660;</span>
									<span>{isExpanded ? 'Hide document' : 'View document'}</span>
								</button>
								{#if isExpanded}
									<div class="px-5 pb-4">
										{#if proposal.fetching}
											<p class="text-text-secondary text-sm">Loading document from permanent storage...</p>
										{:else if proposal.fetched}
											<div class="p-4 rounded bg-bg border border-border">
												<div class="doc-viewer prose prose-invert max-w-none text-sm">
													{@html proposal.htmlContent}
												</div>
												{#if proposal.metadata?.arweaveTxId}
													<div class="mt-3 pt-3 border-t border-border text-xs text-text-muted">
														Arweave TX: <a href={arweaveUrl(proposal.metadata.arweaveTxId)} target="_blank" rel="noopener noreferrer" class="font-mono text-primary hover:underline">{proposal.metadata.arweaveTxId}</a>
													</div>
												{/if}
											</div>
										{:else if !proposal.metadata?.arweaveTxId}
											<p class="text-text-muted text-sm">No document content available.</p>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Passed Proposals (ready to execute) -->
		<section class="mb-8">
			<h2 class="text-lg font-medium mb-4">Ready to Execute <Tooltip text={"These proposals passed the vote. Any connected wallet can execute them, recording the ratified document on-chain via: Snapshot X \u2192 Gnosis Safe \u2192 DAARegistry."} align="left"><span class="text-sm font-normal text-text-muted cursor-help">(?)</span></Tooltip></h2>
			{#if passedProposals.length === 0}
				<p class="text-text-muted text-sm">No proposals awaiting execution.</p>
			{:else}
				<div class="flex flex-col gap-4">
					{#each passedProposals as proposal}
						{@const tally = tallyBar(proposal.votesFor, proposal.votesAgainst, proposal.votesAbstain)}
						{@const approvalNeeded = approvalVotesNeeded(proposal.executionStrategy)}
						{@const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain}
						{@const isExpanded = expandedId === proposal.proposalId}

						<div class="border border-cat-gold/40 rounded-lg bg-bg-light">
							<!-- Card header — always visible -->
							<div class="px-5 py-4">
								<div class="flex items-start justify-between gap-4 mb-2">
									<div>
										<div class="flex items-center gap-2 mb-1">
											<span class="font-mono text-text-muted text-xs">#{proposal.proposalId}</span>
											<span class="text-sm font-medium text-cat-gold">{statusLabel(proposal.status)}</span>
											<span class="text-xs text-text-muted">{strategyLabel(proposal.executionStrategy)}</span>
										</div>
										<h3 class="text-base font-medium">{proposal.metadata?.title ?? `Proposal #${proposal.proposalId}`}</h3>
										{#if proposal.documentLabel}
											<div class="flex items-center gap-3 mt-1">
												<span class="text-xs text-text-muted">{proposal.documentLabel}</span>
											</div>
										{/if}
										{#if proposal.metadata?.restrictions}
											<div class="flex items-center gap-1 mt-1">
												<span class="text-xs text-cat-gold">Restrictions: {formatRestrictions(proposal.metadata.restrictions)}</span>
											</div>
										{/if}
									</div>
								</div>

								<div class="flex items-center justify-between text-xs text-text-muted">
									<span>For: {Number(proposal.votesFor)} / Against: {Number(proposal.votesAgainst)} / Abstain: {Number(proposal.votesAbstain)}</span>
									<span>Approval: {Number(proposal.votesFor)}/{Number(approvalNeeded)}</span>
								</div>

								<!-- Execute button — always visible -->
								<div class="mt-4 pt-3 border-t border-border">
									{#if $wallet.connected}
										<button
											onclick={() => handleExecute(proposal)}
											disabled={executingId === proposal.proposalId}
											class="px-5 py-2 rounded text-sm font-medium bg-cat-gold/20 text-cat-gold hover:bg-cat-gold/30 transition-colors cursor-pointer disabled:opacity-50"
										>
											{executingId === proposal.proposalId ? 'Executing...' : 'Execute Proposal'}
										</button>
									{:else}
										<p class="text-text-muted text-sm">Connect your wallet to execute this proposal.</p>
									{/if}
								</div>
							</div>

							<!-- Document fold — click to expand/collapse -->
							<div class="border-t border-border">
								<button
									onclick={() => toggleExpand(proposal.proposalId)}
									class="w-full text-left px-5 py-2 cursor-pointer flex items-center gap-2 text-xs text-text-muted hover:text-text-secondary transition-colors"
								>
									<span class="transition-transform {isExpanded ? 'rotate-180' : ''}">&#9660;</span>
									<span>{isExpanded ? 'Hide document' : 'View document'}</span>
								</button>
								{#if isExpanded}
									<div class="px-5 pb-4">
										{#if proposal.fetching}
											<p class="text-text-secondary text-sm">Loading document from permanent storage...</p>
										{:else if proposal.fetched}
											<div class="p-4 rounded bg-bg border border-border">
												<div class="doc-viewer prose prose-invert max-w-none text-sm">
													{@html proposal.htmlContent}
												</div>
												{#if proposal.metadata?.arweaveTxId}
													<div class="mt-3 pt-3 border-t border-border text-xs text-text-muted">
														Arweave TX: <a href={arweaveUrl(proposal.metadata.arweaveTxId)} target="_blank" rel="noopener noreferrer" class="font-mono text-primary hover:underline">{proposal.metadata.arweaveTxId}</a>
													</div>
												{/if}
											</div>
										{:else if !proposal.metadata?.arweaveTxId}
											<p class="text-text-muted text-sm">No document content available.</p>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- History (collapsible) -->
		{#if historyProposals.length > 0}
			<section>
				<button
					onclick={() => historyExpanded = !historyExpanded}
					class="flex items-center gap-2 text-lg font-medium cursor-pointer mb-4"
				>
					<span>History</span>
					<span class="text-text-muted text-xs">({historyProposals.length})</span>
					<span class="text-text-muted text-xs transition-transform {historyExpanded ? 'rotate-180' : ''}">&#9660;</span>
				</button>

				{#if historyExpanded}
					<div class="flex flex-col gap-1">
						{#each historyProposals as proposal}
							<div class="flex items-center justify-between px-4 py-2 rounded border border-border bg-bg-light">
								<div class="flex items-center gap-3">
									<span class="font-mono text-text-muted text-xs w-6 text-right">#{proposal.proposalId}</span>
									<span class="text-sm">{proposal.metadata?.title ?? `Proposal #${proposal.proposalId}`}</span>
									<span class="text-xs {statusClass(proposal.status)}">{statusLabel(proposal.status)}</span>
								</div>
								<div class="flex items-center gap-3 text-xs text-text-muted">
									{#if proposal.documentLabel}<span>{proposal.documentLabel}</span>{/if}
									<span>For: {Number(proposal.votesFor)} / Against: {Number(proposal.votesAgainst)}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		<!-- Empty state -->
		{#if activeProposals.length === 0 && passedProposals.length === 0 && historyProposals.length === 0}
			<div class="text-center py-12">
				<p class="text-text-muted">No proposals have been created yet.</p>
				{#if $wallet.isTokenHolder}
					<p class="text-text-muted text-sm mt-2">
						<a href="/propose" class="text-primary hover:underline">Create the first proposal</a>
					</p>
				{/if}
			</div>
		{/if}
	{/if}
</div>
