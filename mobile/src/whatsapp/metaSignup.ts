// "Connect with WhatsApp": Meta's own sign-up window (WhatsApp Embedded Signup). The company chooses or
// adds its number and confirms it with a code by SMS or a call, all in Meta's window; the app gets back a
// one-time code and the number's ids, and the server does the rest. Web only (it is a Facebook window).
declare global {
  interface Window { FB?: any; fbAsyncInit?: () => void }
}

export interface SignupResult { code: string; phoneNumberId: string; wabaId: string }

function loadSdk(appId: string): Promise<any> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
      resolve(window.FB);
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Could not open WhatsApp\'s sign-up: check the internet connection'));
    document.body.appendChild(s);
  });
}

/** Opens Meta's window; resolves when the company finished it, rejects (with a plain reason) if they stopped. */
export async function metaSignup(appId: string, configId: string): Promise<SignupResult> {
  const FB = await loadSdk(appId);
  return new Promise((resolve, reject) => {
    let code: string | null = null;
    let ids: { phoneNumberId: string; wabaId: string } | null = null;
    const finish = () => { if (code && ids) { window.removeEventListener('message', onMessage); resolve({ code, ...ids }); } };
    const onMessage = (e: MessageEvent) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
      try {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (d?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (d.event === 'FINISH' || d.event === 'FINISH_ONLY_WABA') { ids = { phoneNumberId: String(d.data?.phone_number_id ?? ''), wabaId: String(d.data?.waba_id ?? '') }; finish(); }
        else if (d.event === 'CANCEL') { window.removeEventListener('message', onMessage); reject(new Error(d.data?.current_step ? `Stopped at "${d.data.current_step}": try again when you are ready` : 'Stopped: try again when you are ready')); }
        else if (d.event === 'ERROR') { window.removeEventListener('message', onMessage); reject(new Error(d.data?.error_message ?? 'WhatsApp gave an error: try again')); }
      } catch { /* not ours */ }
    };
    window.addEventListener('message', onMessage);
    FB.login((resp: any) => {
      if (resp?.authResponse?.code) { code = resp.authResponse.code; finish(); setTimeout(() => { if (!ids) { window.removeEventListener('message', onMessage); reject(new Error('WhatsApp did not say which number: try again')); } }, 8000); }
      else { window.removeEventListener('message', onMessage); reject(new Error('The window was closed before the end: try again when you are ready')); }
    }, { config_id: configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } });
  });
}
