<script lang="ts">
	import { onMount } from "svelte";

	let mountEl: HTMLDivElement;
	let status: "idle" | "loading" | "ready" | "missing" | "error" = "idle";
	let error: string | null = null;
	let input = "";
	let log: string[] = ["Aperture v0.1 — type `HELP GO`"];

	type ApertureModule = {
		default: (input?: unknown) => Promise<unknown> | unknown;
		start: (mountId: string) => void;
		parse_line: (line: string) => unknown;
	};

	let mod: ApertureModule | null = null;

	onMount(async () => {
		status = "loading";
		try {
			// Built by plugins/ruflo-aperture/scripts/build-wasm.sh
			// @ts-expect-error — artifact may not exist until first build
			const m = (await import("$lib/aperture/aperture_wasm.js")) as ApertureModule;
			await m.default();
			m.start("aperture-mount");
			mod = m;
			status = "ready";
		} catch (e) {
			status = "missing";
			error = e instanceof Error ? e.message : String(e);
		}
	});

	function execute() {
		const line = input.trim();
		if (!line || !mod) return;
		log = [...log, `> ${line}`];
		try {
			const ast = mod.parse_line(line);
			log = [...log, `ast: ${JSON.stringify(ast)}`];
			// Phase B: relay parsed command onto window.postMessage so the host
			// worker can forward it to ruflo's message-bus.ts.
		} catch (e) {
			log = [...log, `error: ${e instanceof Error ? e.message : String(e)}`];
		}
		input = "";
	}
</script>

<svelte:head>
	<title>Aperture · Market Workspace</title>
</svelte:head>

<main class="aperture-host">
	<header>
		<strong>Aperture</strong>
		<span>multi-pane market workspace · pane = swarm agent</span>
		<span class="status status-{status}">{status}</span>
	</header>

	{#if status === "missing"}
		<section class="missing">
			<p>Aperture WASM artifact not found.</p>
			<pre>plugins/ruflo-aperture/scripts/build-wasm.sh</pre>
			<p>Then reload this page.</p>
			{#if error}<pre class="err">{error}</pre>{/if}
		</section>
	{/if}

	<section class="panes">
		<div class="pane" id="aperture-mount" bind:this={mountEl}>
			<em>(panes mount here once the wasm shell boots)</em>
		</div>
	</section>

	<section class="log">
		{#each log as line, i (i)}<div>{line}</div>{/each}
	</section>

	<form on:submit|preventDefault={execute}>
		<input
			type="text"
			bind:value={input}
			placeholder="SYMBOL VERB [ARGS] GO   (e.g. AAPL CHART 6M GO)"
			autocomplete="off"
		/>
	</form>
</main>

<style>
	.aperture-host {
		display: grid;
		grid-template-rows: auto 1fr auto auto;
		gap: 0.5rem;
		padding: 0.75rem;
		font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
		font-size: 13px;
		min-height: 100vh;
		background: #0b0d10;
		color: #d6d6d6;
	}
	header { display: flex; gap: 0.75rem; align-items: baseline; }
	header strong { color: #f0f0f0; }
	header .status { margin-left: auto; opacity: 0.7; }
	.panes { border: 1px solid #232830; padding: 0.5rem; min-height: 18rem; }
	.pane { padding: 0.5rem; }
	.log { border: 1px solid #232830; padding: 0.5rem; max-height: 12rem; overflow-y: auto; }
	form input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: #11151a;
		border: 1px solid #232830;
		color: #f0f0f0;
		font: inherit;
	}
	.missing { border: 1px solid #5b3a00; padding: 0.5rem; background: #1d1303; }
	.err { color: #ff8a8a; white-space: pre-wrap; }
</style>
