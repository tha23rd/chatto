// Ambient global for the hardened native desktop renderer. Kept out of
// `app.d.ts` so upstream pulls of that file stay conflict-free; the browser
// build simply never sets `window.chattoNative`.
declare global {
  interface Window {
    /** Present only inside the hardened native desktop renderer. */
    chattoNative?: import('@chatto/native-bridge').ChattoNativeClient;
  }
}

export {};
