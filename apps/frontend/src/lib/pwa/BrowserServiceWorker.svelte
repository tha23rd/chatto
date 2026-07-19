<!-- @component Registers the PWA worker only when the app is browser-hosted. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { registerBrowserServiceWorker } from '$lib/pwa/registerServiceWorker';

  onMount(() => {
    void registerBrowserServiceWorker().catch(() => {
      // Offline shell support is best-effort; the online application remains usable.
      console.warn('The browser service worker could not be registered.');
    });
  });
</script>
