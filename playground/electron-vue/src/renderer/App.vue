<script setup lang="ts">
import { ref } from 'vue'

const count = ref(0)
const platform = ref(window.electronAPI.platform)
</script>

<template>
  <main class="shell">
    <h1>Nasti Electron Vue</h1>
    <p>{{ platform }}</p>
    <button type="button" @click="count++">Count: {{ count }}</button>
  </main>
</template>

<style scoped>
.shell {
  display: grid;
  gap: 1rem;
  max-width: 36rem;
  margin: 4rem auto;
  font-family: system-ui, sans-serif;
}
</style>
