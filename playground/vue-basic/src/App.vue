<script setup lang="ts">
import { ref } from 'vue'
import Scoped from './Scoped.vue'
const count = ref(0)
</script>

<template>
  <h1 class="title">Nasti + Vue</h1>
  <button @click="count++">count: {{ count }}</button>
  <Scoped />
</template>

<style>
.title {
  color: #42b883;
}
</style>
