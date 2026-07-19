<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { completeServerOAuth, parseServerOAuthTokenResponse } from '$lib/auth/serverOAuth';
  import { loadAndClearFlowState } from '$lib/oauth/pkce';
  import * as m from '$lib/i18n/messages';
  import PageTitle from '$lib/ui/PageTitle.svelte';
  import { Button } from '$lib/ui/form';

  let status = $state<'loading' | 'error'>('loading');
  let errorMessage = $state('');

  onMount(async () => {
    const code = page.url.searchParams.get('code');
    const state = page.url.searchParams.get('state');
    const errorParam = page.url.searchParams.get('error');

    // Handle error responses from the authorization server
    if (errorParam) {
      status = 'error';
      errorMessage =
        page.url.searchParams.get('error_description') ||
        m['auth.callback.authorization_failed']({ error: errorParam });
      return;
    }

    if (!code) {
      status = 'error';
      errorMessage = m['auth.callback.no_code']();
      return;
    }

    // Load the saved flow state (verifier, remote URL, etc.)
    const flow = loadAndClearFlowState();
    if (!flow) {
      status = 'error';
      errorMessage = m['auth.callback.missing_flow']();
      return;
    }

    // Validate state parameter (CSRF protection)
    if (state !== flow.state) {
      status = 'error';
      errorMessage = m['auth.callback.invalid_state']();
      return;
    }

    // Build the redirect_uri that we used in the authorize request
    const redirectUri = `${window.location.origin}/servers/callback`;

    try {
      // Exchange the authorization code for a bearer token
      const response = await fetch(`${flow.remoteUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          code_verifier: flow.verifier,
          redirect_uri: redirectUri
        }),
        signal: AbortSignal.timeout(10000)
      });

      const result: unknown = await response.json();

      if (!response.ok) {
        const error =
          result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
        status = 'error';
        errorMessage =
          (typeof error.error_description === 'string' && error.error_description) ||
          (typeof error.error === 'string' && error.error) ||
          m['auth.callback.token_exchange_failed']();
        return;
      }

      const route = completeServerOAuth(flow, parseServerOAuthTokenResponse(result));
      await goto(route);
    } catch (err) {
      status = 'error';
      if (err instanceof DOMException && err.name === 'AbortError') {
        errorMessage = m['auth.callback.token_exchange_timeout']();
      } else {
        errorMessage =
          err instanceof Error &&
          err.message === 'OAuth token response did not include an access token.'
            ? m['auth.callback.no_access_token']()
            : err instanceof Error
              ? err.message
              : m['auth.callback.token_exchange_failed']();
      }
    }
  });
</script>

<PageTitle title={m['auth.callback.connecting_title']()} />

<div class="flex min-h-0 flex-1 items-center justify-center p-8">
  {#if status === 'loading'}
    <div class="flex flex-col items-center gap-4">
      <span class="iconify animate-spin text-3xl text-muted mdi--loading"></span>
      <p class="text-muted">{m['auth.callback.completing']()}</p>
    </div>
  {:else}
    <div class="flex max-w-md flex-col items-center gap-4 text-center">
      <span class="iconify text-4xl text-danger uil--exclamation-triangle"></span>
      <p class="font-medium">{m['auth.callback.failed_title']()}</p>
      <p class="text-sm text-muted">{errorMessage}</p>
      <Button href={resolve('/')} variant="secondary">{m['common.retry']()}</Button>
    </div>
  {/if}
</div>
