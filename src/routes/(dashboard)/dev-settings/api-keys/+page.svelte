<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">API keys</h1>

<div class="mb-6 space-y-2 text-sm text-[hsl(var(--muted-foreground))]">
	<p>
		Keys authenticate the REST API via
		<code class="rounded bg-[hsl(var(--muted))] px-1">Authorization: Bearer us_…</code>.
	</p>
	<p>
		Agents (Hermes, Cursor, etc.) should use the HTTP MCP endpoint
		<code class="rounded bg-[hsl(var(--muted))] px-1">/mcp</code>
		with the same Bearer header. Full URL:
		<code class="rounded bg-[hsl(var(--muted))] px-1">https://your-host/mcp</code>. MCP is
		compose-only — it can compose flows and templates, but cannot send mail or activate flows.
		Optional domain scoping limits which domain the agent can see.
	</p>
	<p>
		Alternatively, for local agents via stdio, run
		<code class="rounded bg-[hsl(var(--muted))] px-1">npm run mcp</code>
		and set
		<code class="rounded bg-[hsl(var(--muted))] px-1">OWLERY_API_KEY</code>
		in the MCP server env.
	</p>
</div>

{#if data.needsDomain}
	<p class="text-sm text-[hsl(var(--muted-foreground))]">Select a domain to manage API keys.</p>
{:else}
	<Card title="Create key" class="mb-6">
		<form method="POST" action="?/create" use:enhance class="grid gap-3 sm:grid-cols-2">
			<Input name="name" placeholder="Production" required />
			<select name="permission" class="h-9 rounded-md border px-3 text-sm">
				<option value="FULL">Full</option>
				<option value="SENDING">Sending only</option>
			</select>
			<select name="domainId" class="h-9 rounded-md border px-3 text-sm sm:col-span-2">
				<option value="">All domains</option>
				{#each data.domains as domain}
					<option value={domain.id} selected={domain.id === data.currentDomainId}>
						{domain.name}
					</option>
				{/each}
			</select>
			<Button type="submit" class="sm:col-span-2">Create</Button>
		</form>
		{#if form?.error}
			<p class="mt-3 text-sm text-red-600">{form.error}</p>
		{/if}
		{#if form?.newKey}
			<p class="mt-3 rounded border bg-[hsl(var(--muted))] p-2 font-mono text-xs break-all">
				Copy now — shown once: {form.newKey}
			</p>
		{/if}
	</Card>

	<ul class="space-y-2">
		{#each data.keys as key}
			<li class="flex items-center justify-between rounded-lg border p-4">
				<div>
					<p class="font-medium">{key.name}</p>
					<p class="font-mono text-xs text-[hsl(var(--muted-foreground))]">{key.partialToken}</p>
					<p class="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
						Domain: {key.domainLabel}
					</p>
				</div>
				<form method="POST" action="?/delete" use:enhance>
					<input type="hidden" name="id" value={key.id} />
					<Button type="submit" size="sm" variant="destructive">Delete</Button>
				</form>
			</li>
		{/each}
	</ul>
{/if}
