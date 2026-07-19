<!-- @component Launch-on-startup preference shown only inside supported native clients. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import * as m from '$lib/i18n/messages';
  import { getNativeClient } from '$lib/native/client';
  import { FormSection } from '$lib/ui';
  import { Checkbox } from '$lib/ui/form';
  import { toast } from '$lib/ui/toast';

  const nativeClient = getNativeClient();
  const visible = nativeClient !== null && nativeClient.platform !== 'linux';
  let launchOnStartup = $state(false);
  let loading = $state(false);

  onMount(() => {
    if (!visible || !nativeClient) return;
    void nativeClient
      .getLaunchOnStartup()
      .then((enabled) => (launchOnStartup = enabled))
      .catch(() => toast.error(m['native.startup.startup_failed']()));
  });

  async function handleChange(event: Event) {
    if (!nativeClient) return;
    const desired = (event.currentTarget as HTMLInputElement).checked;
    loading = true;
    try {
      const saved = await nativeClient.setLaunchOnStartup(desired);
      if (!saved) throw new Error('launch-on-startup setting was not confirmed');
      launchOnStartup = desired;
      toast.success(m['native.startup.startup_saved']());
    } catch {
      launchOnStartup = !desired;
      toast.error(m['native.startup.startup_failed']());
    } finally {
      loading = false;
    }
  }
</script>

{#if visible}
  <FormSection title={m['native.startup.title']()} maxWidth="max-w-md" bordered>
    <Checkbox
      id="native-launch-on-startup"
      checked={launchOnStartup}
      {loading}
      label={m['native.startup.launch_on_startup']()}
      description={m['native.startup.launch_on_startup_description']()}
      onchange={handleChange}
    />
  </FormSection>
{/if}
