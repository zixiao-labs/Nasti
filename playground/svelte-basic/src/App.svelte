<script lang="ts">
  let count: number = $state(0)
</script>

<main>
  <h1>Nasti + Svelte</h1>
  <button id="counter" onclick={() => count++}>Count {count}</button>
</main>

<style>
  button { color: rgb(220, 70, 20); }
</style>
