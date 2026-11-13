<script lang="ts">
  import { counter } from './counter.svelte'
  const title: string = 'Nasti + Svelte'
</script>

<main>
  <h1>{title}</h1>
  <button onclick={() => counter.count++}>Count: {counter.count}</button>
  <p>Edit App.svelte to test HMR.</p>
</main>

<style>
  main { font-family: sans-serif; padding: 2rem; }
  button { color: #ff3e00; font-size: 1.25rem; }
</style>
